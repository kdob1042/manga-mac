//! Minimal, audited Tripo API adapter.
//!
//! The provider API is deliberately kept outside Blender. The API key lives in the
//! native connection registry only; project JSON stores the selected image hash,
//! model/task metadata and the verified downloaded asset, never credentials.

use crate::{llm::TripoConnection, policy_transport::PolicyTransport, storage};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const API_ORIGIN: &str = "https://api.tripo3d.ai";
pub const API_BASE: &str = "https://api.tripo3d.ai/v2/openapi";
pub const MODEL_VERSION: &str = "v2.5-20250123";
const MAX_IMAGE: usize = 20 * 1024 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_MODEL: u64 = 512 * 1024 * 1024;

fn failure() -> String {
    "Tripo要求を完了できませんでした。新規送信せず、保存済みtaskの状態を確認してください".into()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn job<'a>(project: &'a Value, id: &str) -> Result<&'a Value, String> {
    project["jobs"]
        .as_array()
        .ok_or("Missing jobs")?
        .iter()
        .find(|item| item["id"].as_str() == Some(id) && item["scope"]["type"] == "tripoModel")
        .ok_or_else(|| "モデル生成要求がありません".into())
}
fn update(
    db: &Mutex<Connection>,
    id: &str,
    update: impl FnOnce(&Value, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let mut connection = db.lock().map_err(|_| failure())?;
    storage::update_remote_job(&mut connection, id, update)
}
fn task_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn image_bytes(manifest: &Value) -> Result<(Vec<u8>, String), String> {
    let input = &manifest["image"];
    let uri = input["image"].as_str().ok_or("生成画像がありません")?;
    let (prefix, encoded) = uri.split_once(',').ok_or("参照画像の形式が不正です")?;
    let mime = prefix
        .strip_prefix("data:")
        .and_then(|s| s.strip_suffix(";base64"))
        .ok_or("参照画像の形式が不正です")?;
    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
        return Err("Tripoへ送れる参照画像はPNG/JPEG/WebPです".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "参照画像の形式が不正です")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE {
        return Err("参照画像は20MB以下にしてください".into());
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if input["hash"].as_str() != Some(hash.as_str())
        || input["size"].as_u64().is_some_and(|size| size != bytes.len() as u64)
    {
        return Err("生成入力の画像版が一致しません".into());
    }
    Ok((bytes, mime.to_string()))
}
fn allowed_manifest(manifest: &Value) -> Result<(), String> {
    let object = manifest.as_object().ok_or("生成条件が不正です")?;
    let allowed = ["version", "provider", "model", "mode", "source", "image", "prompt"];
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || manifest["version"] != 1
        || manifest["provider"] != "tripo"
        || manifest["model"] != MODEL_VERSION
        || manifest["mode"] != "image_to_model"
    {
        return Err("未対応のTripo生成条件です".into());
    }
    let prompt = manifest["prompt"].as_str().ok_or("生成指示がありません")?;
    if prompt.len() > 1000 || prompt.chars().any(char::is_control) {
        return Err("生成指示が不正です".into());
    }
    let source = manifest["source"].as_object().ok_or("生成元がありません")?;
    if source.get("character_id").and_then(Value::as_str).is_none()
        || source.get("snapshot_id").and_then(Value::as_str).is_none()
    {
        return Err("生成元の人物・原稿版がありません".into());
    }
    Ok(())
}
async fn json_response(response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success()
        || response.content_length().is_some_and(|size| size > MAX_RESPONSE as u64)
        || !response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .is_some_and(|kind| kind == "application/json")
    {
        return Err(failure());
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(failure());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| failure())
}
fn auth(request: reqwest::RequestBuilder, connection: &TripoConnection) -> reqwest::RequestBuilder {
    request
        .bearer_auth(&connection.credential)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(180))
}
fn multipart_image(bytes: &[u8], mime: &str) -> (Vec<u8>, String) {
    let boundary = format!("manga_mac_{}", uuid::Uuid::new_v4().simple());
    let extension = match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    };
    let mut body = Vec::with_capacity(bytes.len() + 256);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"reference.{extension}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}
async fn upload(
    client: &reqwest::Client,
    connection: &TripoConnection,
    bytes: &[u8],
    mime: &str,
) -> Result<String, String> {
    let (body, content_type) = multipart_image(bytes, mime);
    let url = reqwest::Url::parse(&format!("{API_BASE}/upload")).map_err(|_| failure())?;
    let value = json_response(
        auth(
            client.post(url).header("Content-Type", content_type).body(body),
            connection,
        )
        .send()
        .await
        .map_err(|_| failure())?,
    )
    .await?;
    let token = value["data"]["image_token"]
        .as_str()
        .filter(|token| task_id(token))
        .ok_or_else(failure)?;
    Ok(token.to_string())
}
async fn create_task(
    client: &reqwest::Client,
    connection: &TripoConnection,
    token: &str,
) -> Result<String, String> {
    let url = reqwest::Url::parse(&format!("{API_BASE}/task")).map_err(|_| failure())?;
    let value = json_response(
        auth(
            client
                .post(url)
                .json(&json!({
                    "type": "image_to_model",
                    "file": {"type": "jpg", "image_token": token},
                    "model_version": MODEL_VERSION,
                    "texture": true,
                    "pbr": true
                })),
            connection,
        )
        .send()
        .await
        .map_err(|_| failure())?,
    )
    .await?;
    let task = value["data"]["task_id"]
        .as_str()
        .filter(|task| task_id(task))
        .ok_or_else(failure)?;
    Ok(task.to_string())
}
pub async fn submit(
    db: &Mutex<Connection>,
    root: &Path,
    id: &str,
    connection: &TripoConnection,
) -> Result<Value, String> {
    let manifest = {
        let db = db.lock().map_err(|_| failure())?;
        let project = storage::load(&db, root)?
            .ok_or("作品が読み込まれていません")?;
        let project: Value = serde_json::from_str(&project).map_err(|_| failure())?;
        job(&project, id)?["manifest"].clone()
    };
    allowed_manifest(&manifest)?;
    let (bytes, mime) = image_bytes(&manifest)?;
    {
        let db = db.lock().map_err(|_| failure())?;
        let current = job(&storage::raw_project(&db)?, id)?;
        if current["remote"]["task_id"].as_str().is_some() {
            return Err("この生成要求はすでに送信済みです。新規送信せず状態を確認してください".into());
        }
    }
    let client = PolicyTransport::external_client(
        &reqwest::Url::parse(API_ORIGIN).map_err(|_| failure())?,
    )
    .await?;
    // The marker is committed before both upload and POST. An interrupted request
    // therefore remains recoverable and cannot be silently resent.
    update(db, id, |_, j| {
        if j["remote"]["submitted_at"].as_u64().is_some() {
            return Err("送信済み要求です。状態を確認してください".into());
        }
        Ok(json!({
            "provider":"tripo",
            "model":MODEL_VERSION,
            "status":"uploading",
            "submitted_at":now(),
            "approved_credits":connection.max_credits
        }))
    })?;
    let token = upload(&client, connection, &bytes, &mime).await?;
    let remote_task = create_task(&client, connection, &token).await;
    match remote_task {
        Ok(task) => update(db, id, |_, j| {
            let mut remote = j["remote"].clone();
            remote["task_id"] = json!(task);
            remote["status"] = json!("queued");
            remote["input_hash"] = manifest["image"]["hash"].clone();
            remote["input_size"] = json!(bytes.len());
            Ok(remote)
        }),
        Err(error) => Err(error),
    }
}
fn saved_task(db: &Mutex<Connection>, id: &str) -> Result<String, String> {
    let db = db.lock().map_err(|_| failure())?;
    let task = job(&storage::raw_project(&db)?, id)?["remote"]["task_id"]
        .as_str()
        .ok_or("Tripoのtask IDがありません。新規送信せず要求を確認してください")?;
    if !task_id(task) {
        return Err(failure());
    }
    Ok(task.to_string())
}
fn safe_status(value: &Value, task: &str) -> Result<Value, String> {
    let data = &value["data"];
    if data["task_id"].as_str() != Some(task) {
        return Err(failure());
    }
    let status = data["status"].as_str().ok_or_else(failure)?;
    if !["queued", "running", "success", "failed", "cancelled", "banned", "expired"]
        .contains(&status)
    {
        return Err(failure());
    }
    let mut result = json!({"status":status});
    if let Some(progress) = data["progress"].as_u64().filter(|value| *value <= 100) {
        result["progress"] = json!(progress);
    }
    Ok(result)
}
async fn fetch_status(
    db: &Mutex<Connection>,
    id: &str,
    connection: &TripoConnection,
) -> Result<Value, String> {
    let task = saved_task(db, id)?;
    update(db, id, |_, j| {
        if j["remote"]["last_poll"]
            .as_u64()
            .is_some_and(|last| now().saturating_sub(last) < 5)
        {
            return Err("状態照会は5秒以上あけてください".into());
        }
        let mut remote = j["remote"].clone();
        remote["last_poll"] = json!(now());
        Ok(remote)
    })?;
    let client = PolicyTransport::external_client(
        &reqwest::Url::parse(API_ORIGIN).map_err(|_| failure())?,
    )
    .await?;
    let url = reqwest::Url::parse(&format!("{API_BASE}/task/{task}")).map_err(|_| failure())?;
    let value = json_response(
        auth(client.get(url), connection)
            .send()
            .await
            .map_err(|_| failure())?,
    )
    .await?;
    let safe = safe_status(&value, &task)?;
    update(db, id, |_, j| {
        let mut remote = j["remote"].clone();
        for (key, value) in safe.as_object().ok_or_else(failure)? {
            remote[key] = value.clone();
        }
        Ok(remote)
    })?;
    Ok(value)
}
pub async fn status(
    db: &Mutex<Connection>,
    id: &str,
    connection: &TripoConnection,
) -> Result<Value, String> {
    fetch_status(db, id, connection).await?;
    let db = db.lock().map_err(|_| failure())?;
    Ok(job(&storage::raw_project(&db)?, id)?["remote"].clone())
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && !ip.is_unspecified()
                && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                && !(ip.octets()[0] == 198 && (18..=19).contains(&ip.octets()[1]))
                && !(ip.octets()[0] == 192 && ip.octets()[1] == 0 && ip.octets()[2] == 0)
                && ip.octets()[0] < 224
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
async fn download_model(url: &str, assets: &Path, task: &str) -> Result<Value, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| failure())?;
    if parsed.scheme() != "https"
        || parsed.port_or_known_default() != Some(443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Tripo出力のURLが安全なHTTPSではありません".into());
    }
    let host = parsed.host_str().ok_or_else(failure)?.to_string();
    let port = 443;
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    .map_err(|_| failure())?
    .map_err(|_| failure())?
    .filter(|address| public_ip(address.ip()))
    .collect();
    if addresses.is_empty() {
        return Err("Tripo出力先が許可できないネットワークです".into());
    }
    std::fs::create_dir_all(assets).map_err(|_| failure())?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &addresses)
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| failure())?;
    let mut response = client
        .get(parsed)
        .header("Accept", "model/gltf-binary,application/octet-stream")
        .send()
        .await
        .map_err(|_| failure())?;
    if !response.status().is_success()
        || response.content_length().is_some_and(|size| size > MAX_MODEL)
    {
        return Err(failure());
    }
    let path = assets.join(format!("tripo-{task}.glb"));
    let temporary = assets.join(format!(".tripo-{task}.pending"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| failure())?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
        size = size.checked_add(chunk.len() as u64).ok_or_else(failure)?;
        if size > MAX_MODEL {
            let _ = std::fs::remove_file(&temporary);
            return Err("Tripoモデルは512MB以下にしてください".into());
        }
        digest.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk).map_err(|_| failure())?;
    }
    file.sync_all().map_err(|_| failure())?;
    let hash = format!("{:x}", digest.finalize());
    let bytes = std::fs::read(&temporary).map_err(|_| failure())?;
    if bytes.len() < 4 || &bytes[..4] != b"glTF" {
        let _ = std::fs::remove_file(&temporary);
        return Err("Tripoの出力がGLBではありません".into());
    }
    std::fs::rename(&temporary, &path).map_err(|_| failure())?;
    Ok(json!({"file":path.file_name().and_then(|name|name.to_str()).ok_or_else(failure)?,"hash":hash,"bytes":size}))
}
fn asset_path(assets: &Path, file: &str) -> Result<PathBuf, String> {
    let name = Path::new(file)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(failure)?;
    if name != file || !file.to_ascii_lowercase().ends_with(".glb") {
        return Err("保存済みTripo素材のpathが不正です".into());
    }
    let root = std::fs::canonicalize(assets).map_err(|_| failure())?;
    let path = root.join(file);
    if std::fs::symlink_metadata(&path)
        .map_err(|_| failure())?
        .file_type()
        .is_symlink()
        || std::fs::canonicalize(&path)
            .map_err(|_| failure())?
            .parent()
            != Some(root.as_path())
    {
        return Err("保存済みTripo素材のpathが不正です".into());
    }
    Ok(path)
}
pub async fn collect(
    db: &Mutex<Connection>,
    id: &str,
    connection: &TripoConnection,
    assets: &Path,
) -> Result<Value, String> {
    let saved = {
        let db = db.lock().map_err(|_| failure())?;
        job(&storage::raw_project(&db)?, id)?["remote"]["artifact"].clone()
    };
    if !saved.is_null() {
        let file = saved["file"].as_str().ok_or_else(failure)?;
        let bytes = std::fs::read(asset_path(assets, file)?).map_err(|_| failure())?;
        if format!("{:x}", Sha256::digest(&bytes)) != saved["hash"] {
            return Err("保存済みTripo素材のhashが一致しません".into());
        }
        return Ok(saved);
    }
    let response = fetch_status(db, id, connection).await?;
    if response["data"]["status"] != "success" {
        return Err("Tripoの生成が完了していません".into());
    }
    let url = response["data"]["output"]["model"]
        .as_str()
        .or_else(|| response["data"]["output"]["base_model"].as_str())
        .or_else(|| response["data"]["output"]["pbr_model"].as_str())
        .ok_or("TripoのGLB出力がありません")?;
    let artifact = download_model(url, assets, &saved_task(db, id)?).await?;
    update(db, id, |_, j| {
        let mut remote = j["remote"].clone();
        remote["status"] = json!("success");
        remote["artifact"] = artifact.clone();
        Ok(remote)
    })?;
    Ok(artifact)
}
pub async fn balance(connection: &TripoConnection) -> Result<Value, String> {
    let client = PolicyTransport::external_client(
        &reqwest::Url::parse(API_ORIGIN).map_err(|_| failure())?,
    )
    .await?;
    let url = reqwest::Url::parse(&format!("{API_BASE}/user/balance")).map_err(|_| failure())?;
    let value = json_response(
        auth(client.get(url), connection)
            .send()
            .await
            .map_err(|_| failure())?,
    )
    .await?;
    let data = &value["data"];
    let balance = data["balance"].as_f64().ok_or_else(failure)?;
    let frozen = data["frozen"].as_f64().ok_or_else(failure)?;
    if !balance.is_finite() || !frozen.is_finite() || balance < 0.0 || frozen < 0.0 {
        return Err(failure());
    }
    Ok(json!({"balance":balance,"frozen":frozen}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_is_hash_bound_and_model_is_fixed() {
        let image = vec![1, 2, 3];
        let hash = format!("{:x}", Sha256::digest(&image));
        let uri = format!("data:image/png;base64,{}", STANDARD.encode(&image));
        let manifest = json!({"version":1,"provider":"tripo","model":MODEL_VERSION,"mode":"image_to_model",
            "source":{"character_id":"c","snapshot_id":"s"},"image":{"image":uri,"hash":hash,"size":3},"prompt":""});
        assert!(allowed_manifest(&manifest).is_ok());
        assert_eq!(image_bytes(&manifest).unwrap().0, image);
        let mut bad = manifest.clone();
        bad["model"] = json!("v3.1-20260211");
        assert!(allowed_manifest(&bad).is_err());
    }
    #[test]
    fn multipart_body_has_no_credential() {
        let (body, content_type) = multipart_image(b"abc", "image/png");
        assert!(content_type.starts_with("multipart/form-data; boundary="));
        assert!(String::from_utf8_lossy(&body).contains("reference.png"));
        assert!(!String::from_utf8_lossy(&body).contains("tsk_"));
    }
}
