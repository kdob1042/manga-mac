#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backup_commands;
mod llm;
mod policy_transport;
mod runway;
pub mod storage;

mod blender;
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
fn save_project(data: String, state: State<AppState>) -> Result<(), String> {
    let mut db = state.db.lock().map_err(err)?;
    storage::save(&mut db, &state.root, &data)
}
#[tauri::command]
fn load_project(state: State<AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(err)?;
    storage::load(&db, &state.root)
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
async fn register_video(
    input: llm::VideoRegistration,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.connections.register_video(input).await
}
#[tauri::command]
fn remove_video(connection_id: String, state: State<AppState>) -> Result<(), String> {
    state.connections.remove_video(&connection_id)
}
fn video_start_image(state: &AppState, job_id: &str) -> Result<String, String> {
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
    let reference = &shot["startImage"];
    match reference["kind"].as_str() {
        Some("artwork") => {
            let artwork = project["artworks"]
                .as_array()
                .ok_or("Missing artwork")?
                .iter()
                .find(|a| a["id"] == reference["id"] && a["hash"] == reference["hash"])
                .ok_or("作画版がありません")?;
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
                &db,
                &state.root,
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
        _ => Err("開始画像の形式が未対応です".into()),
    }
}
#[tauri::command]
async fn video_submit(
    job_id: String,
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state.video.try_lock().map_err(|_| "動画APIの操作中です")?;
    let connection = state.connections.video_connection(&connection_id)?;
    let image = video_start_image(&state, &job_id)?;
    runway::submit(&state.db, &job_id, &connection_id, &connection, &image).await
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
async fn run_engine(input: Option<String>) -> Result<String, String> {
    let mut command = tokio::process::Command::new(engine_path()?);
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
        command.arg("--prepare");
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
    let _guard = state
        .engine
        .try_lock()
        .map_err(|_| "画像エンジンは処理中です")?;
    run_engine(None).await
}
#[tauri::command]
async fn generate_image(mut request: Value, state: State<'_, AppState>) -> Result<String, String> {
    let _guard = state
        .engine
        .try_lock()
        .map_err(|_| "画像エンジンは処理中です")?;
    let width = request["width"].as_u64().unwrap_or(768);
    let height = request["height"].as_u64().unwrap_or(768);
    if !(256..=1024).contains(&width)
        || !(256..=1024).contains(&height)
        || !width.is_multiple_of(64)
        || !height.is_multiple_of(64)
    {
        return Err("未対応の画像寸法です".into());
    }
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
    let destination = {
        let mut db = state.db.lock().map_err(err)?;
        storage::image_recovery::reserve(&mut db, &state.root, &request)?
    };
    request["output"] = destination;
    run_engine(Some(request.to_string())).await?;
    let db = state.db.lock().map_err(err)?;
    let result = storage::image_recovery::recover(
        &db,
        &state.root,
        request["job"]["id"].as_str().ok_or("Missing job ID")?,
    )?;
    Ok(result["image"]
        .as_str()
        .ok_or("Missing image result")?
        .to_string())
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
            blender_fork,
            blender_capture,
            blender_register,
            blender_execute,
            blender_status,
            blender_latest,
            blender_recover,
            github_get,
            github_file,
            github_asset,
            save_project,
            load_project,
            video_playback,
            video_export,
            register_video,
            remove_video,
            video_submit,
            video_task,
            export_file,
            live_export,
            live_video_probe,
            register_llm,
            remove_llm,
            cancel_llm,
            llm_request,
            generate_image,
            recover_image,
            prepare_engine
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
