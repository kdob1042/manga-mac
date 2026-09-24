#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backup_commands;
mod live_preview;
mod llm;
mod local_video;
mod media;
mod policy_transport;
mod runway;
pub mod storage;
mod tapnow;
mod tripo;

mod compositor;
mod legacy_capture;
mod scene_asset;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;
struct AppState {
    base: PathBuf,
    acceptance: Mutex<Option<storage::acceptance::Session>>,
    _workspace_gate: std::fs::File,
    root: PathBuf,
    connections: llm::Connections,
    tapnow: tapnow::Connection,
    db: Mutex<rusqlite::Connection>,
    engine: tokio::sync::Mutex<()>,
    video: tokio::sync::Mutex<()>,
    local_video: Mutex<Option<(String, local_video::Registration)>>,
    compositor_gate: tokio::sync::Mutex<()>,
}
#[tauri::command]
async fn compositor_start(
    session_id: String,
    bundle: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state
        .compositor_gate
        .try_lock()
        .map_err(|_| "Compositor操作中です")?;
    compositor::start(&session_id, bundle).await
}
#[tauri::command]
async fn compositor_call(
    session_id: String,
    request: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state
        .compositor_gate
        .try_lock()
        .map_err(|_| "Compositor操作中です")?;
    if request["op"] == "saved_snapshot" {
        return compositor::saved_snapshot(&session_id);
    }
    compositor::exchange(&session_id, request).await
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("manga-mac/0.1")
        .no_proxy()
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)
}
fn repo_valid(repo: &str) -> bool {
    let p: Vec<_> = repo.split('/').collect();
    p.len() == 2
        && p.iter().all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        })
}
fn local_source_path(repo: &str, app_data: &std::path::Path) -> Result<Option<PathBuf>, String> {
    let configured_repo = std::env::var("MANGA_MAC_LOCAL_SOURCE_REPO").ok();
    let configured_path = std::env::var_os("MANGA_MAC_LOCAL_SOURCE_PATH");
    let (configured_repo, configured_path) = if configured_repo.is_none()
        && configured_path.is_none()
    {
        let settings_path = app_data.join("local-source.json");
        if !settings_path.exists() {
            return Ok(None);
        }
        let settings: Value = serde_json::from_slice(&std::fs::read(&settings_path).map_err(err)?)
            .map_err(|e| format!("ローカル原稿の設定を読めません: {e}"))?;
        (
            settings["repo"].as_str().map(String::from),
            settings["path"].as_str().map(std::ffi::OsString::from),
        )
    } else {
        (configured_repo, configured_path)
    };
    match (configured_repo, configured_path) {
        (None, None) => Ok(None),
        (Some(name), Some(path)) if name == repo && repo_valid(&name) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() || !path.is_dir() {
                return Err("ローカル原稿リポジトリのパスが不正です".into());
            }
            Ok(Some(path))
        }
        (Some(_), Some(_)) => Ok(None),
        _ => Err("ローカル原稿リポジトリの設定が不足しています".into()),
    }
}
async fn local_git(path: &std::path::Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .await
        .map_err(err)?;
    if !output.status.success() {
        return Err(format!(
            "ローカル原稿の読み取りに失敗しました: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}
async fn fetch_local_branch(path: &std::path::Path, branch: &str) -> Result<(), String> {
    if !matches!(branch, "dev" | "main") {
        return Err("原稿ブランチが不正です".into());
    }
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(path)
        .args([
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "origin",
            &refspec,
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| "原稿リポジトリの更新がタイムアウトしました".to_string())?
        .map_err(|_| "原稿リポジトリの更新を開始できませんでした".to_string())?;
    if !output.status.success() {
        return Err(format!(
            "origin/{branch} を取得できません。接続またはGitの認証を確認してください"
        ));
    }
    Ok(())
}
async fn local_source_blob(
    path: &std::path::Path,
    sha: &str,
    file: &str,
) -> Result<Vec<u8>, String> {
    local_git(path, &["cat-file", "blob", &format!("{sha}:{file}")]).await
}
async fn github(repo: &str, path: &str, token: &str, raw: bool) -> Result<String, String> {
    if !repo_valid(repo) {
        return Err("Invalid repository".into());
    }
    let mut req = client()?
        .get(format!("https://api.github.com/repos/{repo}/{path}"))
        .header(
            "Accept",
            if raw {
                "application/vnd.github.raw+json"
            } else {
                "application/vnd.github+json"
            },
        );
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let response = req.send().await.map_err(err)?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub {} — 接続権限・レート制限を確認してください",
            response.status()
        ));
    }
    response.text().await.map_err(err)
}
#[tauri::command]
async fn github_get(
    repo: String,
    path: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !repo_valid(&repo) || !matches!(path.as_str(), "commits/main" | "commits/dev") {
        return Err("Unsupported GitHub operation".into());
    }
    if let Some(local) = local_source_path(&repo, &state.base)? {
        let branch = path.strip_prefix("commits/").expect("validated path");
        fetch_local_branch(&local, branch).await?;
        let reference = format!("refs/remotes/origin/{branch}^{{commit}}");
        let output = local_git(&local, &["rev-parse", "--verify", &reference]).await?;
        let sha = String::from_utf8(output).map_err(err)?.trim().to_string();
        if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("ローカル原稿のcommitが不正です".into());
        }
        return Ok(serde_json::json!({"sha": sha}).to_string());
    }
    github(&repo, &path, &token, false).await
}
#[tauri::command]
async fn github_file(
    repo: String,
    path: String,
    sha: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if sha.len() != 40
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        || path.contains(['\\', '?', '#', '%'])
    {
        return Err("Invalid immutable source path".into());
    }
    if !repo_valid(&repo) {
        return Err("Invalid repository".into());
    }
    if let Some(local) = local_source_path(&repo, &state.base)? {
        return String::from_utf8(local_source_blob(&local, &sha, &path).await?).map_err(err);
    }
    github(&repo, &format!("contents/{path}?ref={sha}"), &token, true).await
}
fn source_asset_path_valid(path: &str) -> bool {
    !path
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
        && !path.contains(['\\', '?', '#', '%'])
        && matches!(
            path.rsplit('.')
                .next()
                .map(|s| s.to_ascii_lowercase())
                .as_deref(),
            Some("png" | "jpg" | "jpeg" | "webp")
        )
}
fn source_asset_response_bytes(content_type: Option<&str>, body: &[u8]) -> Result<Vec<u8>, String> {
    let has_image_signature = source_asset_mime(body).is_some();
    let first_non_whitespace = body.iter().copied().find(|byte| !byte.is_ascii_whitespace());
    let is_json = !has_image_signature
        && (content_type.is_some_and(|value| value.to_ascii_lowercase().contains("json"))
            || first_non_whitespace == Some(b'{'));
    if !is_json {
        return Ok(body.to_vec());
    }
    let response: Value =
        serde_json::from_slice(body).map_err(|_| "参照画像の応答を読み取れません".to_string())?;
    if response["encoding"].as_str() != Some("base64") {
        return Err("参照画像の応答形式が不正です".into());
    }
    let content = response["content"]
        .as_str()
        .ok_or("参照画像の内容がありません")?;
    let compact: Vec<_> = content.bytes().filter(|byte| !byte.is_ascii_whitespace()).collect();
    STANDARD
        .decode(compact)
        .map_err(|_| "参照画像のbase64が不正です".into())
}
#[cfg(test)]
mod source_asset_tests {
    use super::*;

    #[test]
    fn raw_and_contents_json_jpeg_responses_produce_the_same_bytes() {
        let jpeg = b"\xff\xd8\xffsample";
        let raw = source_asset_response_bytes(Some("image/jpeg"), jpeg).unwrap();
        let raw_with_json_media_type =
            source_asset_response_bytes(Some("application/vnd.github.raw+json"), jpeg).unwrap();
        let content = STANDARD.encode(jpeg);
        let json = format!(r#"{{"encoding":"base64","content":"{content}"}}"#);
        let decoded =
            source_asset_response_bytes(Some("application/json; charset=utf-8"), json.as_bytes())
                .unwrap();
        assert_eq!(raw, jpeg);
        assert_eq!(raw_with_json_media_type, jpeg);
        assert_eq!(decoded, jpeg);
        assert_eq!(source_asset_mime(&decoded), Some("image/jpeg"));
    }

    #[test]
    fn malformed_contents_json_is_rejected() {
        assert!(source_asset_response_bytes(
            Some("application/json"),
            br#"{"encoding":"base64","content":"not base64"}"#
        )
        .is_err());
    }
}

fn source_asset_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
#[tauri::command]
async fn github_asset(
    repo: String,
    path: String,
    sha: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !repo_valid(&repo)
        || sha.len() != 40
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
        || !source_asset_path_valid(&path)
    {
        return Err("Invalid immutable source asset path".into());
    }
    let bytes = if let Some(local) = local_source_path(&repo, &state.base)? {
        local_source_blob(&local, &sha, &path).await?
    } else {
        let mut req = client()?
            .get(format!(
                "https://api.github.com/repos/{repo}/contents/{path}?ref={sha}"
            ))
            .header("Accept", "application/vnd.github.raw+json");
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
        let response = req.send().await.map_err(err)?;
        if !response.status().is_success() {
            return Err(format!(
                "GitHub {} — 参照画像の接続権限・レート制限を確認してください",
                response.status()
            ));
        }
        // The raw media type normally returns bytes directly. Keep the contents
        // API JSON/base64 shape as a compatibility fallback for proxies or API
        // responses that ignore the requested media type.
        let max_response_bytes = 28 * 1024 * 1024;
        if response
            .content_length()
            .is_some_and(|size| size > max_response_bytes)
        {
            return Err("参照画像は20MB以下にしてください".into());
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response.bytes().await.map_err(err)?;
        if body.len() as u64 > max_response_bytes {
            return Err("参照画像は20MB以下にしてください".into());
        }
        source_asset_response_bytes(content_type.as_deref(), &body)?
    };
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("参照画像は20MB以下にしてください".into());
    }
    let mime = source_asset_mime(&bytes)
        .ok_or_else(|| "参照画像の実形式がPNG/JPEG/WebPではありません".to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok(serde_json::json!({
        "image": format!("data:{mime};base64,{}", STANDARD.encode(&bytes)),
        "hash": hash,
        "mime": mime,
        "size": bytes.len()
    }))
}
#[tauri::command]
fn source_library(state: State<AppState>) -> Result<Value, String> {
    let _gate = storage::backup::gate(&state.base, ".source-library.lock")?;
    let id = if state.root == state.base {
        "primary".to_string()
    } else {
        state
            .root
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("作品IDが不正です")?
            .to_string()
    };
    let mut entries = storage::source_library::list(&state.base)?;
    if !entries.iter().any(|e| e.id == id) {
        let db = state.db.lock().map_err(err)?;
        let p: Value = storage::load(&db, &state.root)?
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(err)?
            .unwrap_or(Value::Null);
        let snapshot = p["snapshots"]
            .as_array()
            .and_then(|ss| ss.iter().find(|s| s["id"] == p["active"]));
        if let Some(source) = snapshot.filter(|s| s["repo"].as_str().is_some()) {
            entries = storage::source_library::register(
                &state.base,
                storage::source_library::Entry {
                    id: id.clone(),
                    name: p["title"].as_str().unwrap_or("最初の作品").into(),
                    repo: source["repo"].as_str().unwrap().into(),
                    episode: snapshot
                        .and_then(|s| s["episodeId"].as_str())
                        .unwrap_or("P01")
                        .into(),
                    work_id: source["workId"]
                        .as_str()
                        .map(String::from)
                        .or_else(|| source["library"]["workId"].as_str().map(String::from)),
                    work_root: source["library"]["root"].as_str().map(String::from),
                    manifest_path: source["library"]["manifest_path"]
                        .as_str()
                        .map(String::from),
                    catalog_commit: source["library"]["commit"].as_str().map(String::from),
                    scene: source["selectedSceneId"].as_str().map(String::from),
                    format: source["protocol"]["format"].as_str().map(String::from),
                },
            )?;
        }
    }
    Ok(serde_json::json!({"entries":entries,"active":id}))
}
// Keep the existing named Tauri IPC arguments compatible with saved clients.
#[expect(clippy::too_many_arguments)]
#[tauri::command]
fn source_register(
    name: String,
    repo: String,
    episode: String,
    id: Option<String>,
    work_id: Option<String>,
    work_root: Option<String>,
    manifest_path: Option<String>,
    catalog_commit: Option<String>,
    scene: Option<String>,
    format: Option<String>,
    state: State<AppState>,
) -> Result<Value, String> {
    let _gate = storage::backup::gate(&state.base, ".source-library.lock")?;
    let existing = storage::source_library::list(&state.base)?;
    if id.as_ref().is_some_and(|id| {
        !existing.iter().any(|e| &e.id == id) && !(id == "primary" && state.root == state.base)
    }) {
        return Err("未登録の作品です".into());
    }
    let new = id.is_none();
    if new
        && existing
            .iter()
            .any(|e| e.repo.eq_ignore_ascii_case(&repo) && e.work_id.as_ref() == work_id.as_ref())
    {
        return Err("このリポジトリ・作品は登録済みです".into());
    }
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let root = state.base.join("works").join(&id);
    if new {
        std::fs::create_dir_all(root.parent().ok_or("作品フォルダが不正です")?).map_err(err)?;
        std::fs::create_dir(&root).map_err(err)?;
        let db = rusqlite::Connection::open(root.join("manga.sqlite3")).map_err(err)?;
        storage::initialize(&db)?;
    }
    let entries = storage::source_library::register(
        &state.base,
        storage::source_library::Entry {
            id: id.clone(),
            name,
            repo,
            episode,
            work_id,
            work_root,
            manifest_path,
            catalog_commit,
            scene,
            format,
        },
    );
    if entries.is_err() && new {
        let _ = std::fs::remove_dir_all(&root);
    }
    Ok(serde_json::json!({"entries":entries?,"id":id}))
}
#[tauri::command]
fn save_project(data: String, state: State<AppState>) -> Result<(), String> {
    if state.acceptance.lock().map_err(err)?.is_some() {
        storage::acceptance::fixture_project(&data)?;
    }
    let mut db = state.db.lock().map_err(err)?;
    storage::save_checked(&mut db, &state.root, &data)
}
#[tauri::command]
fn load_project(state: State<AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(err)?;
    storage::load(&db, &state.root)
}
#[tauri::command]
fn prepare_source_patch(
    work_id: String,
    op_id: String,
    base_content_token: String,
    target_snapshot_id: String,
    expected: Value,
    state: State<AppState>,
) -> Result<Value, String> {
    let mut db = state.db.lock().map_err(err)?;
    storage::source_patch::prepare(
        &mut db,
        &state.root,
        &work_id,
        &op_id,
        &base_content_token,
        &target_snapshot_id,
        expected,
    )
}
#[tauri::command]
fn rebase_source_patch(
    work_id: String,
    op_id: String,
    base_content_token: String,
    expected: Value,
    state: State<AppState>,
) -> Result<Value, String> {
    let mut db = state.db.lock().map_err(err)?;
    storage::source_patch::rebase(
        &mut db,
        &state.root,
        &work_id,
        &op_id,
        &base_content_token,
        expected,
    )
}
#[tauri::command]
fn commit_source_patch(
    work_id: String,
    op_id: String,
    base_content_token: String,
    target_snapshot_id: String,
    patch: Value,
    state: State<AppState>,
) -> Result<Value, String> {
    let mut db = state.db.lock().map_err(err)?;
    storage::source_patch::commit(
        &mut db,
        &state.root,
        &work_id,
        &op_id,
        &base_content_token,
        &target_snapshot_id,
        patch,
    )
}
#[tauri::command]
fn video_playback(
    app: tauri::AppHandle,
    revision_id: String,
    state: State<AppState>,
) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    let artifact = storage::video_reference(&db, &revision_id)?;
    let path = storage::verify_video(&state.root, &artifact)?;
    // The initial scope is empty. Only this verified, DB-referenced file is allowed.
    app.asset_protocol_scope().allow_file(&path).map_err(err)?;
    Ok(serde_json::json!({"path":path,"artifact":artifact}))
}
#[tauri::command]
fn video_export(
    app: tauri::AppHandle,
    revision_id: String,
    state: State<AppState>,
) -> Result<String, String> {
    let db = state.db.lock().map_err(err)?;
    let artifact = storage::video_reference(&db, &revision_id)?;
    let path = storage::export_video(
        &state.root,
        &app.path().download_dir().map_err(err)?.join("Manga Mac"),
        &artifact,
    )?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
async fn register_image(
    input: llm::VideoRegistration,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .connections
        .register_video(
            input,
            "runway".into(),
            "gen4_image".into(),
            "runway-image".into(),
        )
        .await
}
#[tauri::command]
async fn recover_cloud_image(
    job_id: String,
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state.engine.lock().await;
    let connection = state.connections.video_connection(&connection_id)?;
    runway::collect_image(&state.db, &state.root, &job_id, &connection).await
}
#[tauri::command]
async fn register_video(
    input: llm::VideoRegistration,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let connection = serde_json::json!({
        "provider": input.provider.as_deref().unwrap_or("runway"),
        "model": input.model.as_deref().unwrap_or("gen4.5"),
        "adapter_id": input.adapter_id.as_deref().unwrap_or("runway")
    });
    let selected = media::video_model_from_connection(&connection)?;
    if selected.adapter_id != "runway" {
        return Err("選択した動画adapterはまだ接続されていません".into());
    }
    state
        .connections
        .register_video(
            input,
            selected.provider,
            selected.model_id,
            selected.adapter_id,
        )
        .await
}
#[tauri::command]
fn reuse_video_connection(
    source_connection_id: String,
    provider: String,
    model: String,
    adapter_id: String,
    approved: bool,
    state: State<AppState>,
) -> Result<String, String> {
    let selected = media::video_model_from_connection(&serde_json::json!({
        "provider": provider,
        "model": model,
        "adapter_id": adapter_id
    }))?;
    if selected.adapter_id != "runway" {
        return Err("選択した動画adapterはまだ接続されていません".into());
    }
    state.connections.reuse_video_connection(
        &source_connection_id,
        approved,
        selected.provider,
        selected.model_id,
        selected.adapter_id,
    )
}

#[tauri::command]
fn remove_video(connection_id: String, state: State<AppState>) -> Result<(), String> {
    state.connections.remove_video(&connection_id)
}
#[tauri::command]
async fn tapnow_connect(state: State<'_, AppState>) -> Result<Value, String> {
    tapnow::connect(&state.tapnow).await
}
#[tauri::command]
async fn tapnow_tools(state: State<'_, AppState>) -> Result<Value, String> {
    tapnow::list_tools(&state.tapnow).await
}
#[tauri::command]
fn tapnow_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    tapnow::disconnect(&state.tapnow)
}
#[tauri::command]
fn tapnow_status(state: State<'_, AppState>) -> Result<bool, String> {
    tapnow::connected(&state.tapnow)
}
#[tauri::command]
async fn register_tripo(
    input: llm::TripoRegistration,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.connections.register_tripo(input).await
}
#[tauri::command]
fn remove_tripo(connection_id: String, state: State<AppState>) -> Result<(), String> {
    state.connections.remove_tripo(&connection_id)
}
#[tauri::command]
async fn tripo_balance(connection_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let connection = state.connections.tripo_connection(&connection_id)?;
    tripo::balance(&connection).await
}
#[tauri::command]
async fn tripo_submit(
    job_id: String,
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state
        .video
        .try_lock()
        .map_err(|_| "外部生成APIの操作中です")?;
    let connection = state.connections.tripo_connection(&connection_id)?;
    tripo::submit(&state.db, &state.root, &job_id, &connection).await
}
#[tauri::command]
async fn tripo_task(
    job_id: String,
    connection_id: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state
        .video
        .try_lock()
        .map_err(|_| "外部生成APIの操作中です")?;
    let connection = state.connections.tripo_connection(&connection_id)?;
    match action.as_str() {
        "status" => tripo::status(&state.db, &job_id, &connection).await,
        "collect" => {
            tripo::collect(
                &state.db,
                &job_id,
                &connection,
                &state.root.join("scene-assets"),
            )
            .await
        }
        _ => Err("未対応のTripo操作です".into()),
    }
}
fn resolve_video_image(
    project: &Value,
    db: &rusqlite::Connection,
    root: &std::path::Path,
    reference: &Value,
) -> Result<String, String> {
    match reference["kind"].as_str() {
        Some("artwork") => {
            let artwork = project["artworks"]
                .as_array()
                .ok_or("Missing artwork")?
                .iter()
                .find(|a| a["id"] == reference["id"] && a["hash"] == reference["hash"])
                .ok_or("採用作画版がありません")?;
            artwork["panel"]["image"]
                .as_str()
                .map(str::to_owned)
                .ok_or("作画画像がありません".into())
        }
        Some("capture") => {
            let c = project["captures"]
                .as_array()
                .ok_or("Missing captures")?
                .iter()
                .find(|c| {
                    c["id"] == reference["id"]
                        && c["image"]["hash"] == reference["hash"]
                        && c["dependencies_pinned"] == true
                })
                .ok_or("固定撮影版がありません")?;
            let response = legacy_capture::capture(
                db,
                root,
                c["session_id"].as_str().ok_or("Missing session")?,
                c["request_id"].as_str().ok_or("Missing request")?,
            )?;
            if response["state"]["checkpoint"]["hash"] != c["checkpoint"]["hash"] {
                return Err("撮影版が一致しません".into());
            }
            response["preview"]
                .as_str()
                .map(str::to_owned)
                .ok_or("撮影画像がありません".into())
        }
        _ => Err("動画画像の形式が未対応です".into()),
    }
}

fn video_input_images(state: &AppState, job_id: &str) -> Result<(String, Option<String>), String> {
    let db = state.db.lock().map_err(err)?;
    let project: Value =
        serde_json::from_str(&storage::load(&db, &state.root)?.ok_or("作品がありません")?)
            .map_err(err)?;
    let job = project["jobs"]
        .as_array()
        .ok_or("Missing jobs")?
        .iter()
        .find(|j| j["id"].as_str() == Some(job_id))
        .ok_or("Missing job")?;
    let shot = project["videoShots"]
        .as_array()
        .ok_or("Missing shots")?
        .iter()
        .find(|s| s["id"] == job["scope"]["id"])
        .ok_or("Missing shot")?;
    let start = resolve_video_image(&project, &db, &state.root, &shot["startImage"])?;
    let end = if shot["endImage"].is_object() {
        Some(resolve_video_image(
            &project,
            &db,
            &state.root,
            &shot["endImage"],
        )?)
    } else {
        None
    };
    Ok((start, end))
}
fn video_job_model(
    state: &AppState,
    job_id: &str,
    connection_id: &str,
    registered: &llm::VideoConnection,
    submitting: bool,
) -> Result<media::VideoModel, String> {
    let db = state.db.lock().map_err(err)?;
    let project: Value =
        serde_json::from_str(&storage::load(&db, &state.root)?.ok_or("作品がありません")?)
            .map_err(err)?;
    let job = project["jobs"]
        .as_array()
        .and_then(|jobs| jobs.iter().find(|job| job["id"].as_str() == Some(job_id)))
        .ok_or("保存済み動画要求がありません")?;
    let connection = &job["manifest"]["connection"];
    if submitting && connection["id"].as_str() != Some(connection_id) {
        return Err("動画要求と選択中の接続が一致しません。元の接続を再登録してください".into());
    }
    let selected = media::video_model_from_connection(connection)?;
    if registered.provider != selected.provider
        || registered.model != selected.model_id
        || registered.adapter_id != selected.adapter_id
    {
        return Err("保存済み動画要求の実行先を別モデルへ変更できません".into());
    }
    Ok(selected)
}

#[tauri::command]
fn register_local_video(
    input: local_video::Registration,
    state: State<AppState>,
) -> Result<String, String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err("LTX-2.5 MLXはApple Silicon Mac専用です".into());
    }
    let config = local_video::validate_config(input)?;
    let id = uuid::Uuid::new_v4().to_string();
    *state.local_video.lock().map_err(err)? = Some((id.clone(), config));
    Ok(id)
}
#[tauri::command]
fn remove_local_video(connection_id: String, state: State<AppState>) -> Result<(), String> {
    let mut slot = state.local_video.lock().map_err(err)?;
    if slot.as_ref().is_some_and(|(id, _)| id == &connection_id) {
        *slot = None;
    }
    Ok(())
}
#[tauri::command]
async fn local_video_submit(
    job_id: String,
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _video = state.video.try_lock().map_err(|_| "動画処理中です")?;
    let _engine = state.engine.try_lock().map_err(|_| "他のAI処理中です")?;
    let config = state
        .local_video
        .lock()
        .map_err(err)?
        .as_ref()
        .filter(|(id, _)| id == &connection_id)
        .map(|(_, config)| config.clone())
        .ok_or("ローカル動画接続を登録してください")?;
    let (image, end) = video_input_images(&state, &job_id)?;
    local_video::submit(
        &state.db,
        &state.root,
        &job_id,
        &connection_id,
        &config,
        &image,
        end.as_deref(),
    )
    .await
}
#[tauri::command]
async fn video_submit(
    job_id: String,
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state.video.try_lock().map_err(|_| "動画APIの操作中です")?;
    let connection = state.connections.video_connection(&connection_id)?;
    let selected = video_job_model(&state, &job_id, &connection_id, &connection, true)?;
    let (start_image, end_image) = video_input_images(&state, &job_id)?;
    match selected.adapter_id.as_str() {
        "runway" => {
            runway::submit(
                &state.db,
                &job_id,
                &connection_id,
                &connection,
                &start_image,
                end_image.as_deref(),
            )
            .await
        }
        _ => Err("選択した動画adapterはまだ接続されていません".into()),
    }
}
#[tauri::command]
async fn video_task(
    job_id: String,
    connection_id: String,
    action: String,
    accept_remote_deletion: bool,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state.video.try_lock().map_err(|_| "動画APIの操作中です")?;
    let connection = state.connections.video_connection(&connection_id)?;
    let selected = video_job_model(&state, &job_id, &connection_id, &connection, false)?;
    if selected.adapter_id != "runway" {
        return Err("選択した動画adapterはまだ接続されていません".into());
    }
    match action.as_str() {
        "status" => runway::status(&state.db, &job_id, &connection).await,
        "collect" => runway::collect(&state.db, &state.root, &job_id, &connection).await,
        "cancel" => runway::cancel(&state.db, &job_id, &connection, accept_remote_deletion).await,
        _ => Err("未対応の動画操作です".into()),
    }
}
#[tauri::command]
async fn register_llm(
    input: llm::Registration,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.connections.register(input).await
}
#[tauri::command]
fn remove_llm(connection_id: String, state: State<AppState>) -> Result<(), String> {
    state.connections.remove(&connection_id)
}
#[tauri::command]
fn cancel_llm(request_id: String, state: State<AppState>) -> Result<(), String> {
    state.connections.cancel(&request_id)
}
#[tauri::command]
async fn llm_request(
    request: llm::Request,
    state: State<'_, AppState>,
) -> Result<llm::Response, String> {
    let _local_guard = if state.connections.is_local(&request.connection_id)? {
        Some(state.engine.lock().await)
    } else {
        None
    };
    state.connections.request(request).await
}
fn engine_path() -> Result<PathBuf, String> {
    let dir = std::env::current_exe()
        .map_err(err)?
        .parent()
        .ok_or("App directory missing")?
        .to_path_buf();
    let bundled = dir.join("manga-engine");
    if bundled.exists() {
        return Ok(bundled);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries/manga-engine-aarch64-apple-darwin");
    if cfg!(debug_assertions) && dev.exists() {
        return Ok(dev);
    }
    Err("画像エンジンが同梱されていません。macOSビルドを使用してください".into())
}
async fn run_engine(input: Option<String>, model_id: &str) -> Result<String, String> {
    let engine = engine_path()?;
    let mut command = if input.is_some() && cfg!(target_os = "macos") {
        let mut sandbox = tokio::process::Command::new("/usr/bin/sandbox-exec");
        sandbox.args(["-p", "(version 1)(allow default)(deny network*)"]);
        sandbox.arg(&engine);
        sandbox
    } else {
        tokio::process::Command::new(&engine)
    };
    command.env_clear();
    for name in ["HOME", "TMPDIR", "PATH", "LANG"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if input.is_none() {
        command.args(["--prepare", model_id]);
    }
    let mut child = command.spawn().map_err(err)?;
    if let Some(body) = input {
        child
            .stdin
            .take()
            .ok_or("Engine stdin unavailable")?
            .write_all(body.as_bytes())
            .await
            .map_err(err)?;
    } else {
        drop(child.stdin.take());
    }
    let out = tokio::time::timeout(Duration::from_secs(3600), child.wait_with_output())
        .await
        .map_err(|_| "画像処理が制限時間を超えました")?
        .map_err(err)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .chars()
            .take(4000)
            .collect());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
#[tauri::command]
async fn prepare_engine(state: State<'_, AppState>) -> Result<String, String> {
    prepare_engine_for(None, state).await
}

async fn prepare_engine_for(
    model_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _guard = state
        .engine
        .try_lock()
        .map_err(|_| "画像エンジンは処理中です")?;
    let selected = media::image_model(model_id.as_deref())?;
    run_engine(None, &selected.model_id).await
}

#[tauri::command]
async fn prepare_media_engine(
    model_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    prepare_engine_for(Some(model_id), state).await
}

#[tauri::command]
fn media_models() -> Result<Value, String> {
    media::public_registry()
}
#[tauri::command]
async fn generate_image(request: Value, state: State<'_, AppState>) -> Result<String, String> {
    let result = generate_media(request, false, state).await?;
    Ok(result["image"]
        .as_str()
        .ok_or("Missing image result")?
        .to_string())
}
#[tauri::command]
async fn generate_layers(request: Value, state: State<'_, AppState>) -> Result<Value, String> {
    generate_media(request, true, state).await
}
async fn generate_media(
    mut request: Value,
    layered: bool,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let selected = media::validate_image_request(&request)?;
    if (selected.output_kind == "ordered-rgba-layers") != layered {
        return Err("画像と多層出力の実行窓口が一致しません".into());
    }
    request["output_kind"] = serde_json::json!(selected.output_kind);
    let _guard = state.engine.lock().await;
    request["media"] = serde_json::json!({
        "registry_id": selected.registry_id.clone(),
        "adapter_id": selected.adapter_id.clone(),
        "model_id": selected.model_id.clone(),
    });
    request["steps"] = serde_json::json!(selected.steps);
    if let Some(original) = request["original"].as_str() {
        let (_, encoded) = original.split_once(',').ok_or("Invalid original image")?;
        let bytes = STANDARD.decode(encoded).map_err(err)?;
        if request["original_hash"].as_str()
            != Some(format!("{:x}", Sha256::digest(&bytes)).as_str())
        {
            return Err("元画像のハッシュが一致しません".into());
        }
    }
    let refs = request["references"]
        .as_array()
        .ok_or("Missing references")?;
    for reference in refs {
        let uri = reference["image"]
            .as_str()
            .ok_or("Missing reference image")?;
        let (_, data) = uri.split_once(',').ok_or("Invalid image")?;
        let bytes = STANDARD.decode(data).map_err(err)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if reference["hash"].as_str() != Some(hash.as_str()) {
            return Err("参照画像のハッシュが一致しません".into());
        }
    }
    if selected.adapter_id == "runway-image" {
        runway::image_payload(&request)?;
        let connection = state.connections.video_connection(
            request["cloud_connection"]
                .as_str()
                .ok_or("静止画接続を登録してください")?,
        )?;
        if connection.adapter_id != "runway-image" {
            return Err("静止画接続が必要です".into());
        }
    }
    let destination = {
        let mut db = state.db.lock().map_err(err)?;
        storage::image_recovery::reserve(&mut db, &state.root, &request)?
    };
    request["output"] = destination;
    if selected.adapter_id == "runway-image" {
        let connection = state.connections.video_connection(
            request["cloud_connection"]
                .as_str()
                .ok_or("静止画接続を登録してください")?,
        )?;
        runway::submit_image(&state.db, &request, &connection).await?;
        // Poll only GET; a stopped/lost request is recovered by its durable task ID.
        let id = request["job"]["id"].as_str().ok_or("Missing job")?;
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_secs(5)).await;
            match runway::collect_image(&state.db, &state.root, id, &connection).await {
                Ok(result) => return Ok(result),
                Err(e)
                    if e.contains("PENDING")
                        || e.contains("RUNNING")
                        || e.contains("THROTTLED") =>
                {
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        return Err("静止画は処理中です。保存済み作画を回収してください".into());
    }
    run_engine(Some(request.to_string()), &selected.model_id).await?;
    let db = state.db.lock().map_err(err)?;
    let result = storage::image_recovery::recover(
        &db,
        &state.root,
        request["job"]["id"].as_str().ok_or("Missing job ID")?,
    )?;
    Ok(result)
}
#[tauri::command]
fn recover_image(job_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    storage::image_recovery::recover(&db, &state.root, &job_id)
}

#[tauri::command]
fn live_video_probe(revision_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    storage::live_export::video_probe(&db, &state.root, &revision_id)
}
#[tauri::command]
fn live_preview_capture(
    revision: u64,
    saved_at: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    storage::live_preview::capture(&db, &state.root, revision, &saved_at)
}
#[tauri::command]
fn live_preview_stage(request: Value, state: State<'_, AppState>) -> Result<Value, String> {
    storage::live_preview::stage(&state.root, &request)
}
#[tauri::command]
fn live_preview_video_probe(
    revision: String,
    video_revision: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    storage::live_preview::video_probe(&state.root, &revision, &video_revision)
}
#[tauri::command]
fn live_preview_cancel(revision: String) -> Result<(), String> {
    live_preview::cancel(&revision)
}
#[tauri::command]
fn live_preview_restore(
    revision: String,
    work_id: String,
    episode_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    storage::live_preview::restore(&state.root, &revision, &work_id, &episode_id)
}
#[tauri::command]
fn live_preview_list(
    work_id: String,
    episode_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    storage::live_preview::list(&state.root, &work_id, &episode_id)
}
#[tauri::command]
async fn live_preview_send(
    revision: String,
    origin: String,
    token: String,
    base_revision: Option<String>,
    work_id: String,
    episode_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    live_preview::begin(&revision)?;
    let _guard = GATE.lock().await;
    live_preview::send(
        &state.root,
        &revision,
        &origin,
        &token,
        base_revision,
        (&work_id, &episode_id),
    )
    .await
}
#[tauri::command]
fn live_export(
    app: tauri::AppHandle,
    request: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    storage::live_export::export(
        &db,
        &state.root,
        &app.path().download_dir().map_err(err)?,
        &request,
    )
}
#[tauri::command]
fn export_file(app: tauri::AppHandle, name: String, data: String) -> Result<String, String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || name.starts_with('.')
    {
        return Err("Invalid export filename".into());
    }
    let dir = app.path().download_dir().map_err(err)?.join("Manga Mac");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_millis();
    let path = dir.join(format!("{stamp}-{name}"));
    let bytes = STANDARD.decode(data).map_err(err)?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(err)?;
    file.write_all(&bytes).map_err(err)?;
    file.sync_all().map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
fn legacy_capture_read(
    session_id: String,
    request_id: String,
    state: State<AppState>,
) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    legacy_capture::capture(&db, &state.root, &session_id, &request_id)
}

#[tauri::command]
fn scene_asset_import(data: String, state: State<AppState>) -> Result<Value, String> {
    scene_asset::import_base64(&state.root, &data)
}

#[tauri::command]
fn scene_asset_url(
    app: tauri::AppHandle,
    file: String,
    hash: String,
    bytes: u64,
    state: State<AppState>,
) -> Result<String, String> {
    let path = scene_asset::verified_path(&state.root, &file, &hash, bytes)?;
    app.asset_protocol_scope().allow_file(&path).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn acceptance_context(state: State<AppState>) -> Result<Option<Value>, String> {
    Ok(state
        .acceptance
        .lock()
        .map_err(err)?
        .as_ref()
        .map(|s| s.context()))
}
#[tauri::command]
fn acceptance_record_stage(
    stage: String,
    status: String,
    evidence: Value,
    state: State<AppState>,
) -> Result<Value, String> {
    state
        .acceptance
        .lock()
        .map_err(err)?
        .as_mut()
        .ok_or("Not an acceptance session")?
        .record(&stage, &status, evidence)
}
#[tauri::command]
fn acceptance_export(image: String, state: State<AppState>) -> Result<Value, String> {
    state
        .acceptance
        .lock()
        .map_err(err)?
        .as_ref()
        .ok_or("Not an acceptance session")?
        .export_png(&image)
}
#[tauri::command]
fn acceptance_finish(state: State<AppState>) -> Result<Value, String> {
    state
        .acceptance
        .lock()
        .map_err(err)?
        .as_ref()
        .ok_or("Not an acceptance session")?
        .finish()
}
fn main() {
    // Parse before creating Tauri or touching any application data directory.
    let mode = match storage::acceptance::parse_args(&std::env::args().skip(1).collect::<Vec<_>>())
    {
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let acceptance_id = match mode {
        storage::acceptance::Mode::Preflight => {
            let report = storage::acceptance::preflight(engine_path().ok().as_deref());
            println!(
                "{}",
                serde_json::to_string_pretty(&report).expect("diagnostic JSON")
            );
            std::process::exit(if storage::acceptance::preflight_passed(&report) {
                0
            } else {
                2
            });
        }
        storage::acceptance::Mode::Session(id) => Some(id),
        storage::acceptance::Mode::Normal => None,
    };
    tauri::Builder::default()
        .setup(move |app| {
            let normal = app.path().app_data_dir()?;
            let (base, dir, workspace_gate, acceptance) = if let Some(id) = &acceptance_id {
                let report = storage::acceptance::preflight(engine_path().ok().as_deref());
                if !storage::acceptance::preflight_passed(&report) {
                    return Err(std::io::Error::other(
                        "Acceptance preflight failed; run --acceptance-preflight",
                    )
                    .into());
                }
                let (session, gate) = storage::acceptance::Session::open(&normal, id, report)
                    .map_err(std::io::Error::other)?;
                (
                    session.root.clone(),
                    session.root.clone(),
                    gate,
                    Some(session),
                )
            } else {
                std::fs::create_dir_all(&normal)?;
                let base = normal.canonicalize()?;
                let dir = backup_commands::initial_root(&base).map_err(std::io::Error::other)?;
                let gate = storage::backup::gate(&dir, ".workspace.lock")
                    .map_err(std::io::Error::other)?;
                storage::backup::recover_work(&base, &dir).map_err(std::io::Error::other)?;
                let _ = runway::cleanup_downloads(&dir);
                (base, dir, gate, None)
            };
            let db = rusqlite::Connection::open(dir.join("manga.sqlite3"))?;
            storage::initialize(&db).map_err(std::io::Error::other)?;
            app.manage(AppState {
                base,
                acceptance: Mutex::new(acceptance),
                _workspace_gate: workspace_gate,
                root: dir,
                connections: llm::Connections::default(),
                tapnow: tapnow::Connection::default(),
                db: Mutex::new(db),
                engine: tokio::sync::Mutex::new(()),
                video: tokio::sync::Mutex::new(()),
                local_video: Mutex::new(None),
                compositor_gate: tokio::sync::Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            acceptance_context,
            acceptance_record_stage,
            acceptance_export,
            acceptance_finish,
            backup_commands::backup_status,
            backup_commands::backup_setup,
            backup_commands::backup_disable,
            backup_commands::backup_history,
            backup_commands::backup_run,
            backup_commands::backup_restore,
            backup_commands::backup_open,
            compositor_start,
            compositor_call,
            legacy_capture_read,
            scene_asset_import,
            scene_asset_url,
            github_get,
            github_file,
            github_asset,
            source_library,
            source_register,
            save_project,
            prepare_source_patch,
            rebase_source_patch,
            commit_source_patch,
            load_project,
            video_playback,
            video_export,
            register_video,
            reuse_video_connection,
            remove_video,
            tapnow_connect,
            tapnow_tools,
            tapnow_disconnect,
            tapnow_status,
            video_submit,
            register_local_video,
            remove_local_video,
            local_video_submit,
            video_task,
            register_tripo,
            remove_tripo,
            tripo_balance,
            tripo_submit,
            tripo_task,
            export_file,
            live_export,
            live_video_probe,
            live_preview_capture,
            live_preview_stage,
            live_preview_video_probe,
            live_preview_cancel,
            live_preview_restore,
            live_preview_list,
            live_preview_send,
            register_llm,
            remove_llm,
            cancel_llm,
            llm_request,
            generate_image,
            register_image,
            recover_cloud_image,
            generate_layers,
            recover_image,
            prepare_engine,
            prepare_media_engine,
            media_models
        ])
        .run(tauri::generate_context!())
        .expect("Manga Mac failed");
}

#[cfg(test)]
mod source_asset_tests {
    use super::{fetch_local_branch, local_git, source_asset_mime, source_asset_path_valid};

    #[tokio::test]
    async fn local_source_fetch_advances_tracking_branch_without_checkout() {
        let root =
            std::env::temp_dir().join(format!("manga-source-fetch-{}", uuid::Uuid::new_v4()));
        let remote = root.join("remote.git");
        let seed = root.join("seed");
        let local = root.join("local");
        std::fs::create_dir(&root).unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| {
            let result = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        git(&root, &["init", "--bare", remote.to_str().unwrap()]);
        git(&root, &["init", seed.to_str().unwrap()]);
        git(&seed, &["config", "user.name", "Test"]);
        git(&seed, &["config", "user.email", "test@example.test"]);
        git(&seed, &["checkout", "-b", "dev"]);
        std::fs::write(seed.join("manuscript.txt"), "first").unwrap();
        git(&seed, &["add", "manuscript.txt"]);
        git(&seed, &["commit", "-m", "first"]);
        git(
            &seed,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&seed, &["push", "origin", "dev"]);
        git(
            &root,
            &[
                "clone",
                "--no-checkout",
                remote.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        );
        let old = local_git(&local, &["rev-parse", "refs/remotes/origin/dev"])
            .await
            .unwrap();
        std::fs::write(seed.join("manuscript.txt"), "second").unwrap();
        git(&seed, &["commit", "-am", "second"]);
        git(&seed, &["push", "origin", "dev"]);
        fetch_local_branch(&local, "dev").await.unwrap();
        let new = local_git(&local, &["rev-parse", "refs/remotes/origin/dev"])
            .await
            .unwrap();
        assert_ne!(old, new);
        assert_eq!(
            local_git(
                &local,
                &[
                    "cat-file",
                    "blob",
                    &format!("{}:manuscript.txt", String::from_utf8_lossy(&new).trim())
                ]
            )
            .await
            .unwrap(),
            b"second"
        );
        assert!(!local.join("manuscript.txt").exists());
        assert!(fetch_local_branch(&local, "untrusted").await.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_asset_paths_are_repository_relative_images_only() {
        assert!(source_asset_path_valid(
            "assets/illustrations/character-reference-yumi.jpg"
        ));
        for path in [
            "../secret.png",
            "/absolute.png",
            "assets//a.png",
            "assets/a.svg",
            "assets/a.png?ref=main",
        ] {
            assert!(!source_asset_path_valid(path), "{path}");
        }
    }

    #[test]
    fn source_asset_type_uses_magic_bytes_not_extension() {
        assert_eq!(
            source_asset_mime(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(source_asset_mime(b"\xff\xd8\xffrest"), Some("image/jpeg"));
        assert_eq!(
            source_asset_mime(b"RIFF\0\0\0\0WEBPrest"),
            Some("image/webp")
        );
        assert_eq!(source_asset_mime(b"<svg></svg>"), None);
    }
}
