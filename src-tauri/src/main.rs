#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;
struct AppState { db: Mutex<rusqlite::Connection>, engine: tokio::sync::Mutex<()> }
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("manga-mac/0.1").timeout(Duration::from_secs(600)).redirect(reqwest::redirect::Policy::none()).build().map_err(err)
}
fn repo_valid(repo: &str) -> bool {
    let p: Vec<_> = repo.split('/').collect();
    p.len() == 2 && p.iter().all(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)))
}
async fn github(repo: &str, path: &str, token: &str, raw: bool) -> Result<String, String> {
    if !repo_valid(repo) { return Err("Invalid repository".into()); }
    let mut req = client()?.get(format!("https://api.github.com/repos/{repo}/{path}")).header("Accept", if raw { "application/vnd.github.raw+json" } else { "application/vnd.github+json" });
    if !token.is_empty() { req = req.bearer_auth(token); }
    let response = req.send().await.map_err(err)?;
    if !response.status().is_success() { return Err(format!("GitHub {} — 接続権限・レート制限を確認してください", response.status())); }
    response.text().await.map_err(err)
}
#[tauri::command]
async fn github_get(repo: String, path: String, token: String) -> Result<String, String> {
    if path != "commits/main" { return Err("Unsupported GitHub operation".into()); }
    github(&repo, &path, &token, false).await
}
#[tauri::command]
async fn github_file(repo: String, path: String, sha: String, token: String) -> Result<String, String> {
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) || path.split('/').any(|s| s.is_empty() || s == "." || s == "..") || path.contains(['\\', '?', '#', '%']) { return Err("Invalid immutable source path".into()); }
    github(&repo, &format!("contents/{path}?ref={sha}"), &token, true).await
}
#[tauri::command]
fn save_project(data: String, state: State<AppState>) -> Result<(), String> {
    let _: Value = serde_json::from_str(&data).map_err(err)?;
    state.db.lock().map_err(err)?.execute("INSERT INTO project(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [&data]).map_err(err)?;
    Ok(())
}
#[tauri::command]
fn load_project(state: State<AppState>) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    state.db.lock().map_err(err)?.query_row("SELECT data FROM project WHERE id=1", [], |r| r.get(0)).optional().map_err(err)
}
#[tauri::command]
async fn ollama(model: String, prompt: String, schema: Value) -> Result<String, String> {
    if model.contains("cloud") || model.contains('/') || model.is_empty() { return Err("ローカルモデル名を指定してください".into()); }
    let response = client()?.post("http://127.0.0.1:11434/api/chat").json(&serde_json::json!({"model":model,"stream":false,"keep_alive":0,"format":schema,"messages":[{"role":"user","content":prompt}]})).send().await.map_err(err)?.error_for_status().map_err(err)?.json::<Value>().await.map_err(err)?;
    response["message"]["content"].as_str().map(str::to_string).ok_or("Ollamaの応答が不正です".into())
}
fn engine_path() -> Result<PathBuf, String> {
    let dir = std::env::current_exe().map_err(err)?.parent().ok_or("App directory missing")?.to_path_buf();
    let bundled = dir.join("manga-engine");
    if bundled.exists() { return Ok(bundled); }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/manga-engine-aarch64-apple-darwin");
    if cfg!(debug_assertions) && dev.exists() { return Ok(dev); }
    Err("画像エンジンが同梱されていません。macOSビルドを使用してください".into())
}
async fn run_engine(input: Option<String>) -> Result<String, String> {
    let mut command = tokio::process::Command::new(engine_path()?);
    command.kill_on_drop(true).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    if input.is_none() { command.arg("--prepare"); }
    let mut child = command.spawn().map_err(err)?;
    if let Some(body) = input { child.stdin.take().ok_or("Engine stdin unavailable")?.write_all(body.as_bytes()).await.map_err(err)?; }
    else { drop(child.stdin.take()); }
    let out = tokio::time::timeout(Duration::from_secs(3600), child.wait_with_output()).await.map_err(|_| "画像処理が制限時間を超えました")?.map_err(err)?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).chars().take(4000).collect()); }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
#[tauri::command]
async fn prepare_engine(state: State<'_, AppState>) -> Result<String, String> {
    let _guard = state.engine.try_lock().map_err(|_| "画像エンジンは処理中です")?;
    run_engine(None).await
}
#[tauri::command]
async fn generate_image(request: Value, state: State<'_, AppState>) -> Result<String, String> {
    let _guard = state.engine.try_lock().map_err(|_| "画像エンジンは処理中です")?;
    let refs = request["references"].as_array().ok_or("Missing references")?;
    for reference in refs {
        let uri = reference["image"].as_str().ok_or("Missing reference image")?;
        let (_, data) = uri.split_once(',').ok_or("Invalid image")?;
        let bytes = STANDARD.decode(data).map_err(err)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if reference["hash"].as_str() != Some(hash.as_str()) { return Err("参照画像のハッシュが一致しません".into()); }
    }
    let output = run_engine(Some(request.to_string())).await?;
    let encoded = output.lines().find_map(|l| l.strip_prefix("MANGA_RESULT:")).ok_or("画像エンジンの応答が不正です")?;
    STANDARD.decode(encoded).map_err(err)?;
    Ok(format!("data:image/png;base64,{encoded}"))
}
fn main() {
    tauri::Builder::default().setup(|app| {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;
        let db = rusqlite::Connection::open(dir.join("manga.sqlite3"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS project(id INTEGER PRIMARY KEY,data TEXT NOT NULL);")?;
        app.manage(AppState { db: Mutex::new(db), engine: tokio::sync::Mutex::new(()) });
        Ok(())
    }).invoke_handler(tauri::generate_handler![github_get, github_file, save_project, load_project, ollama, generate_image, prepare_engine]).run(tauri::generate_context!()).expect("Manga Mac failed");
}
