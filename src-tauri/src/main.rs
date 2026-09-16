#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
pub mod storage;
mod llm;
mod policy_transport;

mod blender;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;
struct AppState {
    root: PathBuf,
    connections: llm::Connections,
    db: Mutex<rusqlite::Connection>,
    engine: tokio::sync::Mutex<()>,
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
fn video_playback(app: tauri::AppHandle, revision_id: String, state: State<AppState>) -> Result<Value, String> {
    let db = state.db.lock().map_err(err)?;
    let artifact = storage::video_reference(&db, &revision_id)?;
    let path = storage::verify_video(&state.root, &artifact)?;
    // The initial scope is empty. Only this verified, DB-referenced file is allowed.
    app.asset_protocol_scope().allow_file(&path).map_err(err)?;
    Ok(serde_json::json!({"path":path,"artifact":artifact}))
}
#[tauri::command]
fn video_export(app: tauri::AppHandle, revision_id: String, state: State<AppState>) -> Result<String, String> {
    let db = state.db.lock().map_err(err)?;
    let artifact = storage::video_reference(&db, &revision_id)?;
    let path = storage::export_video(&state.root, &app.path().download_dir().map_err(err)?.join("Manga Mac"), &artifact)?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
async fn register_llm(input: llm::Registration, state: State<'_, AppState>) -> Result<String, String> {
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
async fn llm_request(request: llm::Request, state: State<'_, AppState>) -> Result<llm::Response, String> {
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
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
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
async fn generate_image(request: Value, state: State<'_, AppState>) -> Result<String, String> {
    let _guard = state
        .engine
        .try_lock()
        .map_err(|_| "画像エンジンは処理中です")?;
    let width = request["width"].as_u64().unwrap_or(768);
    let height = request["height"].as_u64().unwrap_or(768);
    if !(256..=1024).contains(&width) || !(256..=1024).contains(&height) || width % 64 != 0 || height % 64 != 0 {
        return Err("未対応の画像寸法です".into());
    }
    if let Some(original) = request["original"].as_str() {
        let (_, encoded) = original.split_once(',').ok_or("Invalid original image")?;
        let bytes = STANDARD.decode(encoded).map_err(err)?;
        if request["original_hash"].as_str() != Some(format!("{:x}", Sha256::digest(&bytes)).as_str()) {
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
    let output = run_engine(Some(request.to_string())).await?;
    let encoded = output
        .lines()
        .find_map(|l| l.strip_prefix("MANGA_RESULT:"))
        .ok_or("画像エンジンの応答が不正です")?;
    STANDARD.decode(encoded).map_err(err)?;
    Ok(format!("data:image/png;base64,{encoded}"))
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
async fn blender_fork(session_id: String, expected_revision: u64, ids: Vec<String>, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let _guard = state.engine.try_lock().map_err(|_| "Blenderは処理中です")?;
    let mut db = state.db.lock().map_err(err)?;
    blender::fork_shots(&mut db, &session_id, expected_revision, ids)
}
#[tauri::command]
fn blender_capture(session_id: String, request_id: String, state: State<AppState>) -> Result<Value, String> {
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
async fn blender_execute(request: blender::Request, state: State<'_, AppState>) -> Result<Value, String> {
    let _guard = state.engine.try_lock().map_err(|_| "Blenderは処理中です")?;
    blender::execute(&state.db, &state.root, request).await
}
#[tauri::command]
async fn blender_recover(
    session_id: String, request_id: String, expected_revision: u64,
    action: blender::RecoveryAction, state: State<'_, AppState>,
) -> Result<Value, String> {
    let _guard = state.engine.try_lock().map_err(|_| "Blenderは処理中です")?;
    let mut db = state.db.lock().map_err(err)?;
    blender::recover(&mut db, &state.root, &session_id, &request_id, expected_revision, action)
}
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = rusqlite::Connection::open(dir.join("manga.sqlite3"))?;
            storage::initialize(&db).map_err(std::io::Error::other)?;
            blender::initialize(&db).map_err(std::io::Error::other)?;
            app.manage(AppState {
                root: dir,
                connections: llm::Connections::default(),
                db: Mutex::new(db),
                engine: tokio::sync::Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            blender_fork,
            blender_capture,
            blender_register,
            blender_execute,
            blender_status,
            blender_latest,
            blender_recover,
            github_get,
            github_file,
            save_project,
            load_project,
            video_playback,
            video_export,
            export_file,
            register_llm,
            remove_llm,
            cancel_llm,
            llm_request,
            generate_image,
            prepare_engine
        ])
        .run(tauri::generate_context!())
        .expect("Manga Mac failed");
}
