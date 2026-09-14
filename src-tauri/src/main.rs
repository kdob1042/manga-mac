#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod storage;
mod blender;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;
struct AppState {
    root: PathBuf,
    db: Mutex<rusqlite::Connection>,
    engine: tokio::sync::Mutex<()>,
    blender: tokio::sync::Mutex<()>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("manga-mac/0.1")
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
async fn llm_request(
    provider: String,
    base_url: String,
    api_key: String,
    body: Value,
) -> Result<String, String> {
    let base = match provider.as_str() {
        "ollama" => "http://127.0.0.1:11434",
        "openai" => "https://api.openai.com/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "anthropic" => "https://api.anthropic.com/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        "custom" => base_url.trim_end_matches('/'),
        _ => return Err("未対応の接続先です".into()),
    };
    let url = reqwest::Url::parse(base).map_err(|_| "APIのベースURLが不正です")?;
    if provider != "ollama"
        && (url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some())
    {
        return Err("認証情報・クエリを含まないHTTPSのベースURLを指定してください".into());
    }
    let model = body["model"].as_str().ok_or("モデルIDを指定してください")?;
    if model.trim().is_empty() {
        return Err("モデルIDを指定してください".into());
    }
    if provider == "ollama" && (model.contains("cloud") || model.contains('/')) {
        return Err("Ollamaにはローカルモデルを指定してください".into());
    }
    if provider != "ollama" && api_key.trim().is_empty() {
        return Err("APIキーを入力してください".into());
    }
    let path = match provider.as_str() {
        "ollama" => "/api/chat",
        "anthropic" => "/messages",
        _ => "/chat/completions",
    };
    let mut request = client()?.post(format!("{base}{path}")).json(&body);
    if provider == "anthropic" {
        request = request
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01");
    } else if provider != "ollama" {
        request = request.bearer_auth(&api_key);
    }
    // Redirects are disabled in client(). Never forward keys to another host or retry another provider.
    let response = request
        .send()
        .await
        .map_err(|_| "LLMに接続できません。接続先とネットワークを確認してください")?;
    let status = response.status();
    if !status.is_success() {
        let reason = match status.as_u16() {
            401 | 403 => "APIキー・利用権限を確認してください",
            404 => "モデルID・ベースURLを確認してください",
            429 => "利用上限・残高・レート制限を確認してください",
            400 | 422 => "モデルの画像入力・JSON出力への対応を確認してください",
            _ => "接続先サービスの状態を確認してください",
        };
        return Err(format!("LLM HTTP {status}: {reason}"));
    }
    response
        .text()
        .await
        .map_err(|_| "LLMの応答を受信できませんでした".into())
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
    let _guard = state.blender.try_lock().map_err(|_| "Blenderは処理中です")?;
    blender::execute(&state.db, &state.root, request).await
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
                db: Mutex::new(db),
                engine: tokio::sync::Mutex::new(()),
                blender: tokio::sync::Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            blender_register,
            blender_execute,
            blender_status,
            blender_latest,
            github_get,
            github_file,
            save_project,
            load_project,
            export_file,
            llm_request,
            generate_image,
            prepare_engine
        ])
        .run(tauri::generate_context!())
        .expect("Manga Mac failed");
}
