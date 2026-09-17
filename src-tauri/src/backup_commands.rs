use crate::{
    err,
    storage::backup::{self, restic},
    AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    repository: String,
    restic: PathBuf,
    rclone: PathBuf,
    rclone_config: PathBuf,
    password: String,
    consent: bool,
    tools_verified: bool,
    password_saved_elsewhere: bool,
    initialize: bool,
}
fn work(state: &AppState) -> Result<PathBuf, String> {
    let p = state.base.join("backup-work");
    backup::directory(&p)?;
    Ok(p)
}
#[tauri::command]
pub fn backup_status(state: State<AppState>) -> Result<Value, String> {
    let config_path = state.root.join("backup-config.json");
    let config = if config_path.exists() {
        Some(restic::config(&state.root)?)
    } else {
        None
    };
    let status = restic::status(&state.root)?;
    let fingerprint = {
        let db = state.db.lock().map_err(err)?;
        backup::fingerprint(&db)?
    };
    let mut restored = vec![];
    let parent = state.base.join("restored");
    if parent.exists() {
        for entry in std::fs::read_dir(parent).map_err(err)? {
            let entry = entry.map_err(err)?;
            let id = entry.file_name().to_string_lossy().to_string();
            if backup::uuid(&id) && entry.file_type().map_err(err)?.is_dir() {
                restored.push(json!({"id":id,"origin":backup::read_json::<Value>(&entry.path().join("restored-from.json"))?}));
            }
        }
    }
    Ok(
        json!({"config":config,"status":status,"changed":status.last_success==0 || status.saved_fingerprint!=fingerprint,"next_backup":if status.last_success==0 {0}else{status.last_success+backup::WEEK},"restored":restored,"active":state.root.file_name().and_then(|s|s.to_str()).filter(|s|backup::uuid(s)).unwrap_or("primary")}),
    )
}
#[tauri::command]
pub async fn backup_setup(input: Setup, state: State<'_, AppState>) -> Result<(), String> {
    if !input.consent || !input.tools_verified || !input.password_saved_elsewhere {
        return Err("送信対象・公式配布物の確認・復元パスワードの別保管を確認してください".into());
    }
    if input.password.len() < 12 || input.password.contains(['\n', '\r']) {
        return Err("復元用パスワードは改行なし12文字以上にしてください".into());
    }
    restic::validate_repository(&input.repository)?;
    let _gate = backup::gate(&state.base, ".backup-operation.lock")?;
    let mut config = restic::Config {
        repository: input.repository,
        restic: input.restic,
        restic_hash: String::new(),
        rclone: input.rclone,
        rclone_hash: String::new(),
        rclone_config: input.rclone_config,
        destination: String::new(),
        enabled: true,
    };
    restic::tools(&mut config, &state.base, true).await?;
    let mut client = restic::Client::new(
        config.clone(),
        input.password.as_bytes().to_vec(),
        work(&state)?,
    );
    if input.initialize {
        client.run(&["init"], None).await?;
    }
    config.destination = client.destination().await?;
    client.config.destination = config.destination.clone();
    client.run(&["check"], None).await?;
    restic::store_password(&config, &input.password)?;
    backup::series(&state.root)?;
    // A destination change resets local scheduling, never the old repository.
    backup::atomic_json(&state.root.join("backup-config.json"), &config)?;
    restic::save_status(&state.root, &restic::Status::default())
}
#[tauri::command]
pub fn backup_disable(state: State<AppState>) -> Result<(), String> {
    let _gate = backup::gate(&state.base, ".backup-operation.lock")?;
    let mut c = restic::config(&state.root)?;
    c.enabled = false;
    backup::atomic_json(&state.root.join("backup-config.json"), &c)
}
async fn client(state: &AppState) -> Result<restic::Client, String> {
    let mut config = restic::config(&state.root)?;
    restic::tools(&mut config, &state.base, false).await?;
    let password = restic::password(&config)?;
    Ok(restic::Client::new(config, password, work(state)?))
}
#[tauri::command]
pub async fn backup_history(state: State<'_, AppState>) -> Result<Vec<restic::Snapshot>, String> {
    let _gate = backup::gate(&state.base, ".backup-operation.lock")?;
    client(&state).await?.snapshots().await
}
fn failed(root: &Path, status: &mut restic::Status, message: &str) -> Result<(), String> {
    status.phase = "failed".into();
    status.failure = message.into();
    status.failures = status.failures.saturating_add(1);
    status.next_attempt = backup::now()? + if status.failures <= 2 { 3600 } else { 86400 };
    restic::save_status(root, status)
}
#[tauri::command]
pub async fn backup_run(automatic: bool, state: State<'_, AppState>) -> Result<(), String> {
    if !state.root.join("backup-config.json").exists() {
        return if automatic {
            Ok(())
        } else {
            Err("保存先を設定してください".into())
        };
    }
    let config = restic::config(&state.root)?;
    if automatic && !config.enabled {
        return Ok(());
    }
    let _gate = backup::gate(&state.base, ".backup-operation.lock")?;
    let mut status = restic::status(&state.root)?;
    let at = backup::now()?;
    if at < status.last_attempt || at < status.last_success {
        return Err("時計が過去へ変わりました。自動処理を停止します".into());
    }
    if automatic && (at < status.next_attempt || at.saturating_sub(status.last_attempt) < 3600) {
        return Ok(());
    }
    let upload = !automatic
        || status.last_success == 0
        || at.saturating_sub(status.last_success) >= backup::WEEK;
    if !upload && at.saturating_sub(status.last_maintenance) < 86400 {
        return Ok(());
    }
    status.last_attempt = at;
    status.phase = "preparing".into();
    status.failure.clear();
    restic::save_status(&state.root, &status)?;
    let result: Result<(), String> = async {
        let client = client(&state).await?;
        if upload {
            let temp = restic::Temp::new(&work(&state)?)?;
            let bundle = temp.path.join("payload");
            let (revision, fingerprint) = {
                let _engine = state
                    .engine
                    .try_lock()
                    .map_err(|_| "作画中です。次の実行可能時にバックアップします")?;
                let _video = state
                    .video
                    .try_lock()
                    .map_err(|_| "動画取得中です。次の実行可能時にバックアップします")?;
                let db = state.db.lock().map_err(err)?;
                let id = backup::series(&state.root)?;
                backup::prepare(&db, &state.root, &bundle, &id, at)?;
                (
                    crate::storage::raw_project(&db)?["revision"].as_u64(),
                    backup::fingerprint(&db)?,
                )
            };
            status.phase = "uploading".into();
            restic::save_status(&state.root, &status)?;
            let snapshot = client.upload(&bundle, Some(&state.root)).await?;
            status.last_success = snapshot.completed_at;
            status.last_verified = snapshot.completed_at;
            status.snapshot = snapshot.id;
            status.saved_revision = revision;
            status.saved_fingerprint = fingerprint;
            status.phase = "succeeded".into();
            status.failures = 0;
            status.next_attempt = 0;
            restic::save_status(&state.root, &status)?;
        }
        // Upload/verification errors return before this point: never reclaim old
        // backups to make room for a failed new one.
        status.cleanup = "checking".into();
        restic::save_status(&state.root, &status)?;
        match client.cleanup(backup::now()?, Some(&state.root)).await {
            Ok(ids) => {
                status.cleanup = format!(
                    "正常終了：旧版{}件を削除・未参照データ回収・整合性検査済み",
                    ids.len()
                );
                status.last_maintenance = backup::now()?;
            }
            Err(e) => {
                status.cleanup =
                    format!("整理未完了：{e}（削除・容量回収・再検査の完了は未確認。次回再確認）");
                status.next_attempt = backup::now()? + 86400;
            }
        }
        status.phase = "succeeded".into();
        restic::save_status(&state.root, &status)?;
        Ok(())
    }
    .await;
    if let Err(ref e) = result {
        failed(&state.root, &mut status, e)?;
    }
    result
}
#[tauri::command]
pub async fn backup_restore(
    snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _gate = backup::gate(&state.base, ".backup-operation.lock")?;
    let client = client(&state).await?;
    let snapshot = client
        .snapshots()
        .await?
        .into_iter()
        .find(|s| s.id == snapshot_id)
        .ok_or("検証済み履歴にない保存版です")?;
    let fetched = client.fetch(&snapshot.id).await?;
    if backup::verify_bundle(&fetched.path)?.series != snapshot.series {
        return Err("復元した作品IDが一致しません".into());
    }
    backup::restore(&fetched.path, &state.base)
}
#[tauri::command]
pub fn backup_open(
    workspace: String,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let _gate = backup::gate(&state.base, ".backup-operation.lock")?;
    let _engine = state
        .engine
        .try_lock()
        .map_err(|_| "作画終了後に切り替えてください")?;
    let _video = state
        .video
        .try_lock()
        .map_err(|_| "動画処理終了後に切り替えてください")?;
    let root = workspace_root(&state.base, &workspace)?;
    let _db = state.db.lock().map_err(err)?;
    if root != state.root {
        backup::atomic_json(&state.base.join("active-workspace.json"), &workspace)?;
        app.restart();
    }
    Ok(())
}
pub fn workspace_root(base: &Path, id: &str) -> Result<PathBuf, String> {
    if id == "primary" {
        return Ok(base.to_path_buf());
    }
    if !backup::uuid(id) {
        return Err("復元作品IDが不正です".into());
    }
    if base.join("works").join(id).exists() {
        return crate::storage::source_library::root(base, id);
    }
    let root = base.join("restored").join(id);
    backup::regular(&root.join("manga.sqlite3"))?;
    if root.canonicalize().map_err(err)? != root {
        return Err("復元フォルダのリンクを拒否しました".into());
    }
    Ok(root)
}
pub fn initial_root(base: &Path) -> Result<PathBuf, String> {
    let file = base.join("active-workspace.json");
    if file.exists() {
        workspace_root(base, &backup::read_json::<String>(&file)?)
    } else {
        Ok(base.to_path_buf())
    }
}

#[tauri::command]
pub fn backup_rebind_blender(binary: String, state: State<AppState>) -> Result<(), String> {
    let _gate = backup::gate(&state.base, ".backup-operation.lock")?;
    let mut db = state.db.lock().map_err(err)?;
    crate::blender::rebind_restored(&mut db, &state.root, &binary)
}
