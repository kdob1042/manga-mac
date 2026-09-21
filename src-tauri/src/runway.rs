//! One official REST adapter. No SDK server, retries, fallback or secret logging.
use crate::{llm::VideoConnection, media, policy_transport::PolicyTransport, storage};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::Path,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const ORIGIN: &str = "https://api.dev.runwayml.com";
const OUTPUT_HOST: &str = "dnznrvs05pmza.cloudfront.net";
fn failure() -> String {
    "動画APIの応答を確定できませんでした。新規生成を再送せず状態を確認してください".into()
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
        .find(|j| j["id"].as_str() == Some(id) && j["scope"]["type"] == "videoShot")
        .ok_or("動画要求がありません".into())
}
fn update(
    db: &Mutex<Connection>,
    id: &str,
    f: impl FnOnce(&Value, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let mut connection = db.lock().map_err(|_| failure())?;
    storage::update_remote_job(&mut connection, id, f)
}

fn frame_bytes(
    input: &Value,
    image: &str,
    ratio: &str,
    label: &str,
) -> Result<(Vec<u8>, u64, u64), String> {
    let (prefix, encoded) = image
        .split_once(',')
        .ok_or_else(|| format!("{}が不正です", label))?;
    if prefix != "data:image/png;base64" || image.len() > 5_000_000 {
        return Err(format!("{}の形式・サイズが未対応です", label));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| format!("{}が不正です", label))?;
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return Err(format!("{}のPNG寸法を確認できません", label));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| failure())?) as u64;
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| failure())?) as u64;
    let (w, h) = ratio.split_once(':').ok_or_else(failure)?;
    let w = w.parse::<u64>().map_err(|_| failure())?;
    let h = h.parse::<u64>().map_err(|_| failure())?;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || width * h != height * w
    {
        return Err(format!(
            "{}と出力の縦横比を合わせてください。自動切り抜きは行いません",
            label
        ));
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if input["hash"].as_str() != Some(hash.as_str())
        || input["size"].as_u64() != Some(bytes.len() as u64)
        || input["width"].as_u64().is_some_and(|value| value != width)
        || input["height"]
            .as_u64()
            .is_some_and(|value| value != height)
        || bytes.len() > 5_000_000
    {
        return Err(format!("{}の実入力が一致しません", label));
    }
    Ok((bytes, width, height))
}

#[cfg(test)]
pub fn payload(manifest: &Value, image: &str) -> Result<Value, String> {
    payload_with_frames(manifest, image, None)
}

pub fn payload_with_frames(
    manifest: &Value,
    start_image: &str,
    end_image: Option<&str>,
) -> Result<Value, String> {
    let allowed = [
        "version",
        "scope",
        "source",
        "characterIds",
        "sourceDependencies",
        "providerInputs",
        "prompt",
        "duration",
        "ratio",
        "connection",
        "base_revision",
        "transition",
    ];
    if !manifest
        .as_object()
        .is_some_and(|m| m.keys().all(|k| allowed.contains(&k.as_str())))
    {
        return Err("未対応の入力制御です".into());
    }
    let inputs = manifest["providerInputs"]
        .as_array()
        .ok_or("Missing input")?;
    let input_keys = [
        "role",
        "id",
        "hash",
        "media_type",
        "mime",
        "size",
        "width",
        "height",
        "transform",
    ];
    if inputs.iter().any(|i| {
        !i.as_object()
            .is_some_and(|m| m.keys().all(|k| input_keys.contains(&k.as_str())))
    }) {
        return Err("未対応の画像制御です".into());
    }
    let prompt = manifest["prompt"].as_str().ok_or("Missing prompt")?;
    let ratio = manifest["ratio"].as_str().ok_or("Missing ratio")?;
    let duration = manifest["duration"]
        .as_u64()
        .ok_or("動画の尺がありません")?;
    if prompt.trim().is_empty() || prompt.encode_utf16().count() > 1000 {
        return Err("未対応の動画指示です".into());
    }

    // Keep the synthetic end-frame fixture isolated from production models.
    if manifest["connection"]["provider"] == "fixture"
        && manifest["connection"]["model"] == "end-frame-v1"
    {
        if duration != 5
            || ratio != "960:960"
            || inputs.len() != 2
            || end_image.is_none()
            || inputs[0]["role"] != "start_frame"
            || inputs[1]["role"] != "end_frame"
            || inputs.iter().any(|input| {
                input["media_type"] != "image"
                    || input["transform"] != json!({"kind":"identity"})
            })
        {
            return Err("未対応の動画入力です".into());
        }
        let (_, start_width, start_height) =
            frame_bytes(&inputs[0], start_image, ratio, "始端画像")?;
        let end = end_image.ok_or_else(failure)?;
        let (_, end_width, end_height) =
            frame_bytes(&inputs[1], end, ratio, "終端画像")?;
        if start_width != end_width || start_height != end_height {
            return Err(
                "始端・終端画像の寸法が一致しません。保存済み変換を用意してから実行してください"
                    .into(),
            );
        }
        return Ok(json!({
            "model":"end-frame-v1",
            "promptImage":start_image,
            "lastFrame":end,
            "promptText":prompt,
            "ratio":ratio,
            "duration":duration,
            "outputFormat":"mp4"
        }));
    }

    let selected = media::video_model_from_connection(&manifest["connection"])?;
    if selected.adapter_id != "runway"
        || selected.provider != "runway"
        || !selected.durations_sec.contains(&duration)
        || !selected.ratios.iter().any(|supported| supported == ratio)
    {
        return Err("選択した動画モデルが尺・寸法に対応していません".into());
    }
    if inputs.len() != 1
        || end_image.is_some()
        || inputs[0]["role"] != "start_frame"
        || inputs[0]["media_type"] != "image"
        || inputs[0]["transform"] != json!({"kind":"identity"})
    {
        if inputs.len() == 2 && !selected.end_frame {
            return Err(
                "選択した動画接続・モデルは終端画像に対応していません。有料送信は行いません"
                    .into(),
            );
        }
        return Err("未対応の動画入力です".into());
    }
    frame_bytes(&inputs[0], start_image, ratio, "開始画像")?;
    Ok(json!({
        "model":selected.model_id,
        "promptImage":start_image,
        "promptText":prompt,
        "ratio":ratio,
        "duration":duration,
        "outputFormat":"mp4"
    }))
}

fn reserve(
    project: &Value,
    job: &Value,
    connection_id: &str,
    budget: u64,
) -> Result<Value, String> {
    if job.get("remote").is_some()
        || job["status"] != "running"
        || job["manifest"]["connection"]["id"] != connection_id
    {
        return Err("送信済み・未確定要求は再POSTできません".into());
    }
    let selected = media::video_model_from_connection(&job["manifest"]["connection"])?;
    if selected.adapter_id != "runway" || selected.provider != "runway" {
        return Err("選択した動画adapterはまだ接続されていません".into());
    }
    let duration = job["manifest"]["duration"]
        .as_u64()
        .ok_or("動画の尺がありません")?;
    if !selected.durations_sec.contains(&duration) {
        return Err("選択した動画モデルが尺に対応していません".into());
    }
    let credits = selected
        .credits_per_second
        .checked_mul(duration)
        .ok_or("Invalid cost")?;
    let jobs = project["jobs"].as_array().ok_or("Missing jobs")?;
    if jobs.iter().any(|j| {
        j["remote"]["actual_credits"].as_u64().unwrap_or(0)
            > j["remote"]["reserved_credits"].as_u64().unwrap_or(0)
    }) {
        return Err("実績費用が見積りを超えました。料金を再確認するまで新規生成できません".into());
    }
    let spent: u64 = jobs
        .iter()
        .filter_map(|j| j["remote"]["reserved_credits"].as_u64())
        .try_fold(0_u64, |a, b| a.checked_add(b))
        .ok_or("Invalid cost")?;
    if spent.saturating_add(credits) > budget {
        return Err("作品の動画予算上限です。接続設定を確認してください".into());
    }
    let shot = project["videoShots"]
        .as_array()
        .ok_or("Missing video shots")?
        .iter()
        .find(|s| s["id"] == job["scope"]["id"])
        .ok_or("Missing shot")?;
    let snapshot = project["snapshots"]
        .as_array()
        .ok_or("Missing source")?
        .iter()
        .find(|s| s["id"] == shot["snapshotId"])
        .ok_or("Missing source")?;
    if snapshot["sha"] != job["manifest"]["source"]["commit"]
        || snapshot["id"] != job["manifest"]["source"]["snapshotId"]
    {
        return Err("原作版が一致しません".into());
    }
    if project["active"] != job["active_snapshot"]
        || shot["adopted_revision"] != job["base_revision"]
        || shot["snapshotId"] != job["source_revision"]
        || shot["prompt"] != job["manifest"]["prompt"]
        || shot["unitIds"] != job["manifest"]["source"]["unitIds"]
        || shot["sceneId"] != job["manifest"]["source"]["sceneId"]
        || shot["characterIds"] != job["manifest"]["characterIds"]
        || shot["ratio"] != job["manifest"]["ratio"]
        || shot["duration"] != job["manifest"]["duration"]
        || shot["startImage"]["hash"] != job["manifest"]["providerInputs"][0]["hash"]
        || shot["startImage"]["id"] != job["manifest"]["providerInputs"][0]["id"]
        || !({
            let pair = shot["transition"].is_object();
            if pair {
                let transition = &shot["transition"];
                let manifest_transition = &job["manifest"]["transition"];
                shot["endImage"]["kind"] == "artwork"
                    && shot["endImage"]["id"] == job["manifest"]["providerInputs"][1]["id"]
                    && shot["endImage"]["hash"] == job["manifest"]["providerInputs"][1]["hash"]
                    && manifest_transition["pageId"] == transition["pageId"]
                    && manifest_transition["fromPanelId"] == transition["fromPanelId"]
                    && manifest_transition["toPanelId"] == transition["toPanelId"]
                    && manifest_transition["fromIndex"] == transition["fromIndex"]
                    && manifest_transition["toIndex"] == transition["toIndex"]
                    && manifest_transition["fromArtworkRevisionId"]
                        == transition["fromArtworkRevisionId"]
                    && manifest_transition["fromArtworkHash"] == transition["fromArtworkHash"]
                    && manifest_transition["toArtworkRevisionId"]
                        == transition["toArtworkRevisionId"]
                    && manifest_transition["toArtworkHash"] == transition["toArtworkHash"]
                    && job["manifest"]["providerInputs"]
                        .as_array()
                        .is_some_and(|inputs| inputs.len() == 2)
            } else {
                shot["endImage"].is_null()
                    && job["manifest"]["transition"].is_null()
                    && job["manifest"]["providerInputs"]
                        .as_array()
                        .is_some_and(|inputs| inputs.len() == 1)
            }
        })
    {
        return Err("制作要求の基準版が変更されています".into());
    }
    if jobs
        .iter()
        .filter(|j| j["scope"] == job["scope"] && j["base_revision"] == job["base_revision"])
        .count()
        > 3
    {
        return Err("動画の試行上限です".into());
    }
    if jobs.iter().any(|j| {
        j["id"] != job["id"]
            && j["scope"] == job["scope"]
            && [
                "running",
                "unknown",
                "submitted",
                "output_pending",
                "cancel_requested",
            ]
            .contains(&j["status"].as_str().unwrap_or(""))
    }) {
        return Err("先に未確定要求を確認してください".into());
    }
    Ok(json!({"status":"unknown","reserved_credits":credits,"submitted_at":now()}))
}

async fn json_response(mut response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > 1024 * 1024)
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            != Some("application/json")
    {
        return Err(failure());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(failure());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| failure())
}

fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: reqwest::Url,
    connection: &VideoConnection,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .bearer_auth(&connection.credential)
        .header("X-Runway-Version", "2024-11-06")
        .timeout(Duration::from_secs(60))
}

pub async fn submit(
    db: &Mutex<Connection>,
    id: &str,
    connection_id: &str,
    connection: &VideoConnection,
    start_image: &str,
    end_image: Option<&str>,
) -> Result<Value, String> {
    let manifest = {
        let db = db.lock().map_err(|_| failure())?;
        job(&storage::raw_project(&db)?, id)?["manifest"].clone()
    };
    let body = payload_with_frames(&manifest, start_image, end_image)?;
    let url = reqwest::Url::parse(&format!("{ORIGIN}/v1/image_to_video")).map_err(|_| failure())?;
    let client = PolicyTransport::external_client(&url).await?;
    // This commit precedes every possible POST. Failure/cancellation never clears it.
    update(db, id, |p, j| {
        reserve(p, j, connection_id, connection.max_credits)
    })?;
    let response = json_response(
        request(&client, reqwest::Method::POST, url, connection)
            .json(&body)
            .send()
            .await
            .map_err(|_| failure())?,
    )
    .await?;
    let task_id = response["id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(failure)?;
    update(db, id, |_, j| {
        let mut r = j["remote"].clone();
        r["task_id"] = json!(task_id);
        r["status"] = json!("PENDING");
        Ok(r)
    })
}

fn task_id(db: &Mutex<Connection>, id: &str) -> Result<String, String> {
    let db = db.lock().map_err(|_| failure())?;
    let p = storage::raw_project(&db)?;
    let task = job(&p, id)?["remote"]["task_id"]
        .as_str()
        .ok_or("task ID未受領です。自動再送せずサービス側を確認してください")?;
    if uuid::Uuid::parse_str(task).is_err() {
        return Err(failure());
    }
    Ok(task.to_owned())
}

fn safe_status(value: &Value, task: &str) -> Result<Value, String> {
    let status = value["status"].as_str().ok_or_else(failure)?;
    if value["id"].as_str() != Some(task)
        || ![
            "PENDING",
            "THROTTLED",
            "RUNNING",
            "SUCCEEDED",
            "FAILED",
            "CANCELLED",
        ]
        .contains(&status)
    {
        return Err(failure());
    }
    let mut safe = json!({"status":status});
    if let Some(cost) = value["cost"]["credits"].as_u64() {
        safe["actual_credits"] = json!(cost);
    }
    if let Some(progress) = value["progress"]
        .as_f64()
        .filter(|p| (0.0..=1.0).contains(p))
    {
        safe["progress"] = json!(progress);
    }
    // Provider error text/output signed URLs are deliberately not persisted.
    Ok(safe)
}

async fn fetch_status(
    db: &Mutex<Connection>,
    id: &str,
    connection: &VideoConnection,
) -> Result<Value, String> {
    let task = task_id(db, id)?;
    update(db, id, |_, j| {
        let mut r = j["remote"].clone();
        if r["last_poll"]
            .as_u64()
            .is_some_and(|t| now().saturating_sub(t) < 5)
        {
            return Err("状態照会は5秒以上あけてください".into());
        }
        r["last_poll"] = json!(now());
        Ok(r)
    })?;
    let url = reqwest::Url::parse(&format!("{ORIGIN}/v1/tasks/{task}")).map_err(|_| failure())?;
    let client = PolicyTransport::external_client(&url).await?;
    let value = json_response(
        request(&client, reqwest::Method::GET, url, connection)
            .send()
            .await
            .map_err(|_| failure())?,
    )
    .await?;
    let safe = safe_status(&value, &task)?;
    update(db, id, |_, j| {
        let mut r = j["remote"].clone();
        for (k, v) in safe.as_object().ok_or_else(failure)? {
            r[k] = v.clone();
        }
        Ok(r)
    })?;
    Ok(value)
}

pub async fn status(
    db: &Mutex<Connection>,
    id: &str,
    connection: &VideoConnection,
) -> Result<Value, String> {
    fetch_status(db, id, connection).await?;
    let db = db.lock().map_err(|_| failure())?;
    Ok(job(&storage::raw_project(&db)?, id)?["remote"].clone())
}

fn output_url(value: &Value) -> Result<reqwest::Url, String> {
    let outputs = value["output"].as_array().ok_or("動画出力がありません")?;
    if value["status"] != "SUCCEEDED" || outputs.len() != 1 {
        return Err("取得可能な単一動画ではありません".into());
    }
    let url =
        reqwest::Url::parse(outputs[0].as_str().ok_or_else(failure)?).map_err(|_| failure())?;
    if url.scheme() != "https"
        || url.host_str() != Some(OUTPUT_HOST)
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "動画出力先が許可済みCDNと一致しません。新規生成せず接続仕様を確認してください".into(),
        );
    }
    Ok(url)
}

// All cooperating instances serialize temp creation and collection with this gate.
// The gate is never deleted: unlinking a locked gate would create a second lock domain.
fn download_gate(root: &Path) -> Result<std::fs::File, String> {
    let path = root.join(".video-transfer.lock");
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.file_type().is_file() => return Err(failure()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(failure()),
    }
    let gate = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| failure())?;
    gate.try_lock().map_err(|_| {
        "別の動画取得処理が準備中です。新規生成せず取得を再試行してください".to_string()
    })?;
    Ok(gate)
}
const TEMP_PREFIX: &str = ".video-download-v2-";
struct DownloadTemp {
    file: std::fs::File,
    path: std::path::PathBuf,
}
impl DownloadTemp {
    fn new(root: &Path) -> Result<Self, String> {
        let _gate = download_gate(root)?;
        let path = root.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|_| failure())?;
        if file.try_lock().is_err() {
            let _ = std::fs::remove_file(&path);
            return Err(failure());
        }
        Ok(Self { file, path })
    }
}
impl Drop for DownloadTemp {
    fn drop(&mut self) {
        // Keep the per-transfer lock held until the directory entry is gone.
        let _ = std::fs::remove_file(&self.path);
    }
}
/// Reclaim only this protocol's unlocked scratch files, never legacy or adopted media.
/// Best effort at startup: a busy gate or filesystem error must not prevent opening a work.
pub fn cleanup_downloads(root: &Path) -> Result<usize, String> {
    let _gate = download_gate(root)?;
    let mut removed = 0;
    for entry in std::fs::read_dir(root).map_err(|_| failure())? {
        let entry = entry.map_err(|_| failure())?;
        let name = entry.file_name();
        let Some(suffix) = name.to_str().and_then(|s| s.strip_prefix(TEMP_PREFIX)) else {
            continue;
        };
        if !uuid::Uuid::parse_str(suffix).is_ok_and(|id| id.to_string() == suffix) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink() != 1 {
                continue;
            }
        }
        let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(entry.path())
        else {
            continue;
        };
        if file.try_lock().is_err() {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

pub async fn collect(
    db: &Mutex<Connection>,
    root: &Path,
    id: &str,
    connection: &VideoConnection,
) -> Result<Value, String> {
    let saved = {
        let db = db.lock().map_err(|_| failure())?;
        job(&storage::raw_project(&db)?, id)?["remote"]["artifact"].clone()
    };
    if !saved.is_null() {
        storage::verify_video(root, &saved)?;
        return Ok(saved);
    }
    let task = fetch_status(db, id, connection).await?;
    let url = output_url(&task)?;
    let client = PolicyTransport::external_client(&url).await?;
    let response = output_request(&client, url)
        .send()
        .await
        .map_err(|_| failure())?;
    collect_response(db, root, id, response).await
}

// Kept separate from API requests: CDN must never receive the API credential.
fn output_request(client: &reqwest::Client, url: reqwest::Url) -> reqwest::RequestBuilder {
    client.get(url).timeout(Duration::from_secs(180))
}
async fn collect_response(
    db: &Mutex<Connection>,
    root: &Path,
    id: &str,
    mut response: reqwest::Response,
) -> Result<Value, String> {
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > storage::MAX_VIDEO_BYTES)
        || response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            != Some("video/mp4")
    {
        return Err("動画取得が拒否されました。新規生成せず再取得してください".into());
    }
    let mut temporary = DownloadTemp::new(root)?;
    let result = async {
        let mut size = 0_u64;
        while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
            size += chunk.len() as u64;
            if size > storage::MAX_VIDEO_BYTES {
                return Err("動画サイズ上限です".into());
            }
            temporary.file.write_all(&chunk).map_err(|_| failure())?;
        }
        temporary.file.sync_all().map_err(|_| failure())?;
        let artifact = storage::put_video(
            root,
            std::fs::File::open(&temporary.path).map_err(|_| failure())?,
            None,
        )?;
        update(db, id, |_, j| {
            let mut r = j["remote"].clone();
            r["artifact"] = artifact.clone();
            Ok(r)
        })?;
        Ok(artifact)
    }
    .await;
    drop(temporary);
    result
}

pub async fn cancel(
    db: &Mutex<Connection>,
    id: &str,
    connection: &VideoConnection,
    accept_remote_deletion: bool,
) -> Result<Value, String> {
    if !accept_remote_deletion {
        return Err("完了済みの結果もサービス上から削除され得ることを確認してください".into());
    }
    let task = task_id(db, id)?;
    let url = reqwest::Url::parse(&format!("{ORIGIN}/v1/tasks/{task}")).map_err(|_| failure())?;
    let client = PolicyTransport::external_client(&url).await?;
    update(db, id, |_, j| {
        let mut r = j["remote"].clone();
        r["status"] = json!("cancel_requested");
        Ok(r)
    })?;
    let response = request(&client, reqwest::Method::DELETE, url, connection)
        .send()
        .await
        .map_err(|_| failure())?;
    if !response.status().is_success() {
        return Err(failure());
    }
    update(db, id, |_, j| {
        let mut r = j["remote"].clone();
        r["status"] = json!("CANCELLED");
        Ok(r)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn fixture() -> (Value, String) {
        let legacy: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/legacy-v1.json")).unwrap();
        let image = legacy["panels"][0]["image"].as_str().unwrap().to_owned();
        let bytes = STANDARD.decode(image.split_once(',').unwrap().1).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let manifest = json!({"connection":{"id":"c","provider":"runway","model":"gen4.5"},"duration":5,"ratio":"960:960","prompt":"Slow push","source":{"unitIds":["u"],"sceneId":"s","snapshotId":"source","commit":"sha"},"characterIds":[],"providerInputs":[{"id":"a","hash":hash,"size":bytes.len(),"role":"start_frame","media_type":"image","transform":{"kind":"identity"}}]});
        (manifest, image)
    }
    fn transition_fixture() -> (Value, String, String) {
        let (mut manifest, start) = fixture();
        let end = start.clone();
        let bytes = STANDARD.decode(end.split_once(',').unwrap().1).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        manifest["connection"] =
            json!({"id":"fixture","provider":"fixture","model":"end-frame-v1"});
        manifest["providerInputs"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id":"b",
                "hash":hash,
                "size":bytes.len(),
                "role":"end_frame",
                "media_type":"image",
                "transform":{"kind":"identity"}
            }));
        let start_hash = manifest["providerInputs"][0]["hash"].clone();
        manifest["transition"] = json!({
            "pageId":"page",
            "fromPanelId":"a",
            "toPanelId":"b",
            "fromIndex":0,
            "toIndex":1,
            "fromArtworkRevisionId":"a",
            "fromArtworkHash":start_hash,
            "toArtworkRevisionId":"b",
            "toArtworkHash":hash
        });
        (manifest, start, end)
    }

    #[test]
    fn provider_body_uses_actual_bytes_and_registered_model_contract() {
        let (manifest, image) = fixture();
        let body = payload(&manifest, &image).unwrap();
        assert_eq!(body["promptImage"], image);
        assert_eq!(body["duration"], 5);
        assert_eq!(body["model"], "gen4.5");
        assert!(body.get("sourceDependencies").is_none());

        let mut ten_seconds = manifest.clone();
        ten_seconds["duration"] = json!(10);
        assert_eq!(payload(&ten_seconds, &image).unwrap()["duration"], 10);

        let mut turbo = manifest.clone();
        turbo["connection"]["model"] = json!("gen4_turbo");
        turbo["duration"] = json!(6);
        let turbo_body = payload(&turbo, &image).unwrap();
        assert_eq!(turbo_body["model"], "gen4_turbo");
        assert_eq!(turbo_body["duration"], 6);

        for (key, value) in [
            ("duration", json!(11)),
            ("ratio", json!("1920:1080")),
            ("endImage", json!("ignored")),
            ("depth", json!("ignored")),
        ] {
            let mut bad = manifest.clone();
            bad[key] = value;
            assert!(payload(&bad, &image).is_err());
        }
        let mut invented = manifest.clone();
        invented["connection"]["model"] = json!("invented");
        assert!(payload(&invented, &image).is_err());
        let mut bad = manifest.clone();
        bad["providerInputs"][0]["hash"] = json!("0".repeat(64));
        assert!(payload(&bad, &image).is_err());
    }
    #[test]
    fn provider_body_preserves_start_end_bytes_and_rejects_runway_fallback() {
        let (manifest, start, end) = transition_fixture();
        let body = payload_with_frames(&manifest, &start, Some(&end)).unwrap();
        assert_eq!(body["promptImage"], start);
        assert_eq!(body["lastFrame"], end);
        assert_eq!(body["model"], "end-frame-v1");
        assert_eq!(manifest["providerInputs"][0]["role"], "start_frame");
        assert_eq!(manifest["providerInputs"][1]["role"], "end_frame");
        let mut unsupported = manifest.clone();
        unsupported["connection"] = json!({"id":"c","provider":"runway","model":"gen4.5"});
        assert!(payload_with_frames(&unsupported, &start, Some(&end)).is_err());
    }

    #[tokio::test]
    async fn transition_http_fixture_receives_start_and_end_bytes_in_order() {
        let (manifest, start, end) = transition_fixture();
        let body = payload_with_frames(&manifest, &start, Some(&end)).unwrap();
        let expected = body.clone();
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0_u8; 1];
            while !headers.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            let text = String::from_utf8(headers).unwrap().to_lowercase();
            assert!(text.starts_with("post /v1/image_to_video "));
            assert!(text.contains("authorization: bearer fixture-secret"));
            let size: usize = text
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap()
                .parse()
                .unwrap();
            let mut bytes = vec![0; size];
            socket.read_exact(&mut bytes).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
            let response = r#"{"id":"10000000-0000-4000-8000-000000000002"}"#;
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let connection = VideoConnection {
            credential: "fixture-secret".into(),
            max_credits: 60,
            provider: "runway".into(),
            model: "gen4.5".into(),
            adapter_id: "runway".into(),
        };
        let response = request(
            &client,
            reqwest::Method::POST,
            reqwest::Url::parse(&format!("http://{address}/v1/image_to_video")).unwrap(),
            &connection,
        )
        .json(&body)
        .send()
        .await
        .unwrap();
        assert!(json_response(response).await.unwrap()["id"].is_string());
        worker.join().unwrap();
    }

    #[test]
    fn reservation_is_durable_and_non_replayable_with_no_budget_reset() {
        let (manifest, _) = fixture();
        let job = json!({"id":"j","scope":{"type":"videoShot","id":"v"},"status":"running","manifest":manifest,"base_revision":null,"source_revision":"source","active_snapshot":"source"});
        let project = json!({"active":"source","snapshots":[{"id":"source","sha":"sha"}],"jobs":[job],"videoShots":[{"id":"v","adopted_revision":null,"snapshotId":"source","sceneId":"s","unitIds":["u"],"characterIds":[],"prompt":"Slow push","ratio":"960:960","duration":5,"startImage":{"id":"a","hash":manifest["providerInputs"][0]["hash"]}}]});
        let mut db = Connection::open_in_memory().unwrap();
        storage::initialize(&db).unwrap();
        db.execute("INSERT INTO project VALUES(1,?1)", [project.to_string()])
            .unwrap();
        assert!(reserve(&project, &job, "c", 59).is_err());
        storage::update_remote_job(&mut db, "j", |p, j| reserve(p, j, "c", 60)).unwrap();
        assert!(storage::update_remote_job(&mut db, "j", |p, j| reserve(p, j, "c", 6000)).is_err());
        let mut next = storage::raw_project(&db).unwrap();
        next["jobs"][0]["status"] = json!("abandoned");
        let mut second = job.clone();
        second["id"] = json!("j2");
        next["jobs"].as_array_mut().unwrap().push(second.clone());
        assert!(reserve(&next, &second, "c", 60).is_err());
        assert_eq!(
            reserve(&next, &second, "c", 120).unwrap()["reserved_credits"],
            60
        );
    }
    #[test]
    fn reservation_uses_selected_model_rate_and_duration() {
        let (mut manifest, _) = fixture();
        manifest["connection"]["model"] = json!("gen4_turbo");
        let job = json!({
            "id":"j",
            "scope":{"type":"videoShot","id":"v"},
            "status":"running",
            "manifest":manifest,
            "base_revision":null,
            "source_revision":"source",
            "active_snapshot":"source"
        });
        let project = json!({
            "active":"source",
            "snapshots":[{"id":"source","sha":"sha"}],
            "jobs":[job],
            "videoShots":[{
                "id":"v",
                "adopted_revision":null,
                "snapshotId":"source",
                "sceneId":"s",
                "unitIds":["u"],
                "characterIds":[],
                "prompt":"Slow push",
                "ratio":"960:960",
                "duration":5,
                "startImage":{"id":"a","hash":manifest["providerInputs"][0]["hash"]}
            }]
        });
        assert!(reserve(&project, &job, "c", 24).is_err());
        assert_eq!(reserve(&project, &job, "c", 25).unwrap()["reserved_credits"], 25);
    }

    #[test]
    fn output_urls_and_status_projection_never_expose_secrets_or_unapproved_hosts() {
        for url in [
            "http://dnznrvs05pmza.cloudfront.net/v.mp4",
            "https://127.0.0.1/v.mp4",
            "https://evil.example/v.mp4",
            "https://secret@dnznrvs05pmza.cloudfront.net/v.mp4",
            "https://dnznrvs05pmza.cloudfront.net:8443/v.mp4",
        ] {
            assert!(output_url(&json!({"status":"SUCCEEDED","output":[url]})).is_err());
        }
        let value = json!({"id":"id","status":"SUCCEEDED","output":["https://dnznrvs05pmza.cloudfront.net/v.mp4?_jwt=private"],"cost":{"credits":60},"failure":"secret"});
        assert!(output_url(&value).is_ok());
        let safe = safe_status(&value, "id").unwrap();
        assert!(!safe.to_string().contains("private"));
        assert!(!safe.to_string().contains("secret"));
        assert!(safe_status(&value, "other").is_err());
    }
    #[tokio::test]
    async fn real_http_fixture_receives_official_post_headers_and_body() {
        let (manifest, image) = fixture();
        let body = payload(&manifest, &image).unwrap();
        let expected = body.clone();
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0_u8; 1];
            while !headers.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            let text = String::from_utf8(headers).unwrap().to_lowercase();
            assert!(text.starts_with("post /v1/image_to_video "));
            assert!(text.contains("authorization: bearer fixture-secret"));
            assert!(text.contains("x-runway-version: 2024-11-06"));
            let size: usize = text
                .lines()
                .find_map(|l| l.strip_prefix("content-length: "))
                .unwrap()
                .parse()
                .unwrap();
            let mut bytes = vec![0; size];
            socket.read_exact(&mut bytes).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
            let response = r#"{"id":"10000000-0000-4000-8000-000000000001"}"#;
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        });
        // Test-only local transport. Production construction always pins approved HTTPS DNS.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let connection = VideoConnection {
            credential: "fixture-secret".into(),
            max_credits: 60,
            provider: "runway".into(),
            model: "gen4.5".into(),
            adapter_id: "runway".into(),
        };
        let response = request(
            &client,
            reqwest::Method::POST,
            reqwest::Url::parse(&format!("http://{address}/v1/image_to_video")).unwrap(),
            &connection,
        )
        .json(&body)
        .send()
        .await
        .unwrap();
        assert!(json_response(response).await.unwrap()["id"].is_string());
        worker.join().unwrap();
    }
    #[test]
    fn temp_lock_child() {
        let Ok(root) = std::env::var("MANGA_TEST_DOWNLOAD_CHILD") else {
            return;
        };
        let root = Path::new(&root);
        let mut temporary = DownloadTemp::new(root).unwrap();
        temporary.file.write_all(b"partial download").unwrap();
        std::fs::write(
            root.join("child-ready"),
            temporary.path.file_name().unwrap().as_encoded_bytes(),
        )
        .unwrap();
        std::thread::sleep(Duration::from_secs(30));
        drop(temporary);
    }
    #[test]
    fn killed_transfer_is_reclaimed_but_live_legacy_and_linked_files_are_kept() {
        let root = std::env::temp_dir().join(format!("runway-gc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let active = DownloadTemp::new(&root).unwrap();
        let legacy = root.join(format!(".video-download-{}", uuid::Uuid::new_v4()));
        std::fs::write(&legacy, b"legacy may still be live").unwrap();
        let adopted = root.join("saved-video.mp4");
        std::fs::write(&adopted, b"adopted fixture").unwrap();
        let linked = root.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
        std::fs::hard_link(&adopted, &linked).unwrap();
        let directory = root.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        #[cfg(unix)]
        {
            let symlink = root.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
            std::os::unix::fs::symlink(&adopted, symlink).unwrap();
        }
        let gate = download_gate(&root).unwrap();
        assert!(DownloadTemp::new(&root).is_err());
        assert!(cleanup_downloads(&root).is_err());
        drop(gate);
        assert_eq!(cleanup_downloads(&root).unwrap(), 0);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "runway::tests::temp_lock_child", "--nocapture"])
            .env("MANGA_TEST_DOWNLOAD_CHILD", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !root.join("child-ready").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let ready = root.join("child-ready").exists();
        let live_removed = cleanup_downloads(&root);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready, "child did not acquire its transfer lock");
        assert_eq!(live_removed.unwrap(), 0);
        let orphan = root.join(std::fs::read_to_string(root.join("child-ready")).unwrap());
        assert!(orphan.exists());
        assert_eq!(cleanup_downloads(&root).unwrap(), 1);
        assert!(!orphan.exists());
        assert!(active.path.exists() && legacy.exists() && linked.exists() && directory.exists());
        assert_eq!(std::fs::read(&adopted).unwrap(), b"adopted fixture");
        let active_path = active.path.clone();
        drop(active);
        assert!(!active_path.exists());
        assert_eq!(cleanup_downloads(&root).unwrap(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    fn local_response(
        status: &str,
        mime: &str,
        body: Vec<u8>,
        declared: usize,
    ) -> (reqwest::Url, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let mime = mime.to_owned();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0; 1];
            while !headers.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            write!(socket,"HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n").unwrap();
            let _ = socket.write_all(&body);
            String::from_utf8(headers).unwrap().to_lowercase()
        });
        (
            reqwest::Url::parse(&format!("http://{address}/v1/tasks/fixture?token=private"))
                .unwrap(),
            handle,
        )
    }
    fn local_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }
    #[tokio::test]
    async fn task_get_delete_and_error_bodies_keep_credentials_on_api_only() {
        let connection = VideoConnection {
            credential: "fixture-secret".into(),
            max_credits: 60,
            provider: "runway".into(),
            model: "gen4.5".into(),
            adapter_id: "runway".into(),
        };
        for method in [reqwest::Method::GET, reqwest::Method::DELETE] {
            let (url, worker) = local_response("200 OK", "application/json", b"{}".to_vec(), 2);
            let response = request(&local_client(), method.clone(), url, &connection)
                .send()
                .await
                .unwrap();
            json_response(response).await.unwrap();
            let headers = worker.join().unwrap();
            assert!(headers.starts_with(&method.as_str().to_lowercase()));
            assert!(headers.contains("authorization: bearer fixture-secret"));
            assert!(headers.contains("x-runway-version: 2024-11-06"));
        }
        for (status, mime, body, declared) in [
            (
                "404 Not Found",
                "application/json",
                b"fixture-secret".to_vec(),
                14,
            ),
            ("200 OK", "text/html", b"private".to_vec(), 7),
            ("200 OK", "application/json", b"{}".to_vec(), 2_000_000),
            ("200 OK", "application/json", b"{".to_vec(), 1),
        ] {
            let (url, worker) = local_response(status, mime, body, declared);
            let response = request(&local_client(), reqwest::Method::GET, url, &connection)
                .send()
                .await
                .unwrap();
            let error = json_response(response).await.unwrap_err();
            assert!(!error.contains("fixture-secret"));
            assert!(!error.contains("private"));
            worker.join().unwrap();
        }
    }
    #[tokio::test]
    async fn output_http_stream_persists_before_ui_and_rejects_interruption_expiry_and_oversize() {
        let root = std::env::temp_dir().join(format!("runway-stream-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut connection = Connection::open(root.join("test.sqlite3")).unwrap();
        storage::initialize(&connection).unwrap();
        let project = json!({"version":4,"revision":0,"panels":[],"history":[],"jobs":[{"id":"j","scope":{"type":"videoShot","id":"v"},"status":"output_pending","remote":{"status":"SUCCEEDED","reserved_credits":60}}]});
        storage::save(&mut connection, &root, &project.to_string()).unwrap();
        let db = Mutex::new(connection);
        let bytes = STANDARD
            .decode(include_str!("../../tests/fixtures/video-blue.mp4.base64").trim())
            .unwrap();
        for (status, mime, body, declared, success) in [
            (
                "403 Forbidden",
                "text/plain",
                b"expired-private-url".to_vec(),
                19,
                false,
            ),
            (
                "200 OK",
                "video/mp4",
                bytes[..16].to_vec(),
                bytes.len(),
                false,
            ),
            (
                "200 OK",
                "video/mp4",
                Vec::new(),
                storage::MAX_VIDEO_BYTES as usize + 1,
                false,
            ),
            ("200 OK", "video/mp4", b"not an mp4".to_vec(), 10, false),
            ("200 OK", "video/mp4", bytes.clone(), bytes.len(), true),
        ] {
            let (url, worker) = local_response(status, mime, body, declared);
            let response = output_request(&local_client(), url).send().await.unwrap();
            let result = collect_response(&db, &root, "j", response).await;
            assert_eq!(result.is_ok(), success);
            let headers = worker.join().unwrap();
            assert!(headers.starts_with("get "));
            assert!(!headers.contains("authorization:"));
            assert!(!headers.contains("x-runway-version:"));
            let saved = storage::raw_project(&db.lock().unwrap()).unwrap();
            assert_eq!(saved["jobs"][0]["remote"]["reserved_credits"], 60);
            assert_eq!(!saved["jobs"][0]["remote"]["artifact"].is_null(), success);
            if success {
                storage::verify_video(&root, &result.unwrap()).unwrap();
            }
            assert!(!std::fs::read_dir(&root).unwrap().any(|p| p
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".video-download-")));
        }
        drop(db);
        let reopened = Connection::open(root.join("test.sqlite3")).unwrap();
        let saved = storage::raw_project(&reopened).unwrap();
        storage::verify_video(&root, &saved["jobs"][0]["remote"]["artifact"]).unwrap();
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
