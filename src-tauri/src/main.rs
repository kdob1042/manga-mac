#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backup_commands;
mod live_preview;
mod llm;
mod media;
mod policy_transport;
mod runway;
pub mod storage;
mod tripo;
mod web_asset;

mod blender;
mod blender_gui;
mod blender_live;
mod compositor;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;
struct AppState {
    base: PathBuf,
    _workspace_gate: std::fs::File,
    root: PathBuf,
    connections: llm::Connections,
    db: Mutex<rusqlite::Connection>,
    engine: tokio::sync::Mutex<()>,
    video: tokio::sync::Mutex<()>,
    live_blender: blender_live::Live,
    blender_gui: blender_gui::Launcher,
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
async fn github_get(repo: String, path: String, token: String) -> Result<String, String> {
    if path != "commits/main" {
        return Err("Unsupported GitHub operation".into());
    }
    github(&repo, &path, &token, false).await
}
#[tauri::command]
async fn github_file(
    repo: String,
    path: String,
    sha: String,
    token: String,
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
) -> Result<Value, String> {
    if !repo_valid(&repo)
        || sha.len() != 40
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
        || !source_asset_path_valid(&path)
    {
        return Err("Invalid immutable source asset path".into());
    }
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
    if response
        .content_length()
        .is_some_and(|size| size > 20 * 1024 * 1024)
    {
        return Err("参照画像は20MB以下にしてください".into());
    }
    let bytes = response.bytes().await.map_err(err)?;
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
        blender::initialize(&db)?;
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
fn remove_video(connection_id: String, state: State<AppState>) -> Result<(), String> {
    state.connections.remove_video(&connection_id)
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
    app: tauri::AppHandle,
    directory_work: Option<String>,
    scope: Option<String>,
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
            let documents = app.path().document_dir().map_err(err)?;
            let work = directory_work.ok_or("素材フォルダの対象がありません")?;
            let shot_scope = scope.ok_or("生成素材の対象がありません")?;
            let paths = blender_gui::workspace(&documents, &work, &shot_scope)?;
            let assets = paths["assets"].as_str().ok_or("素材フォルダが不正です")?;
            tripo::collect(
                &state.db,
                &job_id,
                &connection,
                std::path::Path::new(assets),
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
            let response = blender::capture(
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
async fn blender_fork(
    session_id: String,
    expected_revision: u64,
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let _guard = state.engine.try_lock().map_err(|_| "Blenderは処理中です")?;
    let mut db = state.db.lock().map_err(err)?;
    blender::fork_shots(&mut db, &session_id, expected_revision, ids)
}
#[tauri::command]
fn blender_capture(
    session_id: String,
    request_id: String,
    state: State<AppState>,
) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    blender::capture(&db, &state.root, &session_id, &request_id)
}
#[tauri::command]
fn blender_register(input: blender::Registration, state: State<AppState>) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    blender::register(&db, input)
}
#[tauri::command]
fn blender_status(session_id: String, state: State<AppState>) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    blender::status(&db, &session_id)
}
#[tauri::command]
fn blender_latest(state: State<AppState>) -> Result<Option<Value>, String> {
    let db = state.db.lock().map_err(err)?;
    blender::latest(&db)
}
#[tauri::command]
async fn blender_execute(
    request: blender::Request,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state.engine.try_lock().map_err(|_| "Blenderは処理中です")?;
    blender::execute(&state.db, &state.root, request).await
}
#[tauri::command]
async fn blender_download_web_asset(
    session_id: String,
    expected_revision: u64,
    input: web_asset::DownloadRequest,
    state: State<'_, AppState>,
) -> Result<web_asset::DownloadedAsset, String> {
    let _guard = state.engine.try_lock().map_err(|_| "Blenderは処理中です")?;
    {
        let db = state.db.lock().map_err(err)?;
        let current = blender::status(&db, &session_id)?;
        if current["revision"].as_u64() != Some(expected_revision)
            || current["jobs"].as_array().is_some_and(|jobs| {
                jobs.iter().any(|job| {
                    matches!(
                        job["status"].as_str(),
                        Some("running" | "unknown" | "candidate")
                    )
                })
            })
        {
            return Err("Blenderの版または要求状態を再確認してください".into());
        }
    }
    web_asset::download(&state.root, input).await
}
#[tauri::command]
async fn blender_recover(
    session_id: String,
    request_id: String,
    expected_revision: u64,
    action: blender::RecoveryAction,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state.engine.try_lock().map_err(|_| "Blenderは処理中です")?;
    let mut db = state.db.lock().map_err(err)?;
    blender::recover(
        &mut db,
        &state.root,
        &session_id,
        &request_id,
        expected_revision,
        action,
    )
}
#[tauri::command]
async fn blender_gui_start(
    app: tauri::AppHandle,
    input: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let documents = app.path().document_dir().map_err(err)?;
    blender_gui::launch(
        &state.blender_gui,
        &state.live_blender,
        &state.base,
        &documents,
        input,
    )
    .await
}
#[tauri::command]
fn blender_workspace(app: tauri::AppHandle, input: Value) -> Result<Value, String> {
    let documents = app.path().document_dir().map_err(err)?;
    let paths = blender_gui::workspace(
        &documents,
        input["directory_work"].as_str().ok_or("Missing work")?,
        input["scope"].as_str().ok_or("Missing shot")?,
    )?;
    if input["open_assets"] == true {
        #[cfg(target_os = "macos")]
        if !std::process::Command::new("/usr/bin/open")
            .arg(paths["assets"].as_str().ok_or("Missing assets")?)
            .status()
            .map_err(err)?
            .success()
        {
            return Err("素材フォルダを開けませんでした".into());
        }
    }
    Ok(paths)
}
#[tauri::command]
async fn blender_live(
    action: String,
    input: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if action == "connect" {
        let file = input["file"].as_str().ok_or("Missing Blender file")?;
        blender_live::validate_working_file(file, &[&state.base, &state.root])?;
    }
    blender_live::command(&state.live_blender, &action, input).await
}
#[tauri::command]
fn blender_working_copy(
    app: tauri::AppHandle,
    session_id: String,
    request_id: String,
    state: State<AppState>,
) -> Result<String, String> {
    let db = state.db.lock().map_err(err)?;
    let saved = blender::capture(&db, &state.root, &session_id, &request_id)?;
    let parent = app.path().download_dir().map_err(err)?.join("Manga Mac");
    std::fs::create_dir_all(&parent).map_err(err)?;
    let folder = parent.join(format!("blender-working-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&folder).map_err(err)?;
    let target = folder.join("working.blend");
    std::fs::copy(
        state
            .root
            .join("blender")
            .join(request_id)
            .join("checkpoint.blend"),
        &target,
    )
    .map_err(err)?;
    if format!("{:x}", Sha256::digest(std::fs::read(&target).map_err(err)?))
        != saved["state"]["checkpoint"]["hash"]
            .as_str()
            .ok_or("Missing checkpoint hash")?
    {
        return Err("作業用コピーの検証に失敗しました".into());
    }
    Ok(target.to_string_lossy().into())
}
#[tauri::command]
async fn blender_live_candidate(input: Value, state: State<'_, AppState>) -> Result<Value, String> {
    let _engine = state.engine.lock().await;
    let result = blender_live::command(&state.live_blender, "candidate", input).await?;
    let mut db = state.db.lock().map_err(err)?;
    let observation: Value = [
        "instance",
        "epoch",
        "revision",
        "file",
        "scene",
        "view_layer",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), result[key].clone()))
    .collect::<serde_json::Map<String, Value>>()
    .into();
    let mut saved = blender::store_live_candidate(
        &mut db,
        &state.root,
        &uuid::Uuid::new_v4().to_string(),
        result,
    )?;
    saved["live_observation"] = observation;
    Ok(saved)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let base = dir.canonicalize()?;
            let dir = backup_commands::initial_root(&base).map_err(std::io::Error::other)?;
            let workspace_gate =
                storage::backup::gate(&dir, ".workspace.lock").map_err(std::io::Error::other)?;
            storage::backup::recover_work(&base, &dir).map_err(std::io::Error::other)?;
            let _ = runway::cleanup_downloads(&dir);
            let db = rusqlite::Connection::open(dir.join("manga.sqlite3"))?;
            storage::initialize(&db).map_err(std::io::Error::other)?;
            blender::initialize(&db).map_err(std::io::Error::other)?;
            app.manage(AppState {
                base,
                _workspace_gate: workspace_gate,
                root: dir,
                connections: llm::Connections::default(),
                db: Mutex::new(db),
                engine: tokio::sync::Mutex::new(()),
                video: tokio::sync::Mutex::new(()),
                live_blender: blender_live::Live::default(),
                blender_gui: blender_gui::Launcher::default(),
                compositor_gate: tokio::sync::Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backup_commands::backup_status,
            backup_commands::backup_setup,
            backup_commands::backup_disable,
            backup_commands::backup_history,
            backup_commands::backup_run,
            backup_commands::backup_restore,
            backup_commands::backup_open,
            backup_commands::backup_rebind_blender,
            compositor_start,
            compositor_call,
            blender_live,
            blender_gui_start,
            blender_workspace,
            blender_live_candidate,
            blender_working_copy,
            blender_fork,
            blender_capture,
            blender_register,
            blender_download_web_asset,
            blender_execute,
            blender_status,
            blender_latest,
            blender_recover,
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
            remove_video,
            video_submit,
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
    use super::{source_asset_mime, source_asset_path_valid};

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
