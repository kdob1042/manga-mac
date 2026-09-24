//! Shared cloud image Job, budget and receipt lifecycle. Provider wire details stay in adapters.
use crate::{
    media, media_connections::Connection as MediaConnection, openai_image,
    policy_transport::PolicyTransport, runway, storage,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex};

pub fn supports(adapter: &str) -> bool {
    matches!(adapter, "runway-image" | "openai-image")
}
fn failure() -> String {
    "クラウド画像要求を完了できません。自動再送しません".into()
}
fn account(c: &MediaConnection) -> String {
    format!("{:x}", Sha256::digest(c.credential.as_bytes()))
}
fn update<F>(db: &Mutex<Connection>, id: &str, f: F) -> Result<Value, String>
where
    F: FnOnce(&Value, &Value) -> Result<Value, String>,
{
    let mut connection = db.lock().map_err(|_| failure())?;
    storage::update_remote_job(&mut connection, id, f)
}
pub fn payload(input: &Value) -> Result<Value, String> {
    match input["media"]["adapter_id"].as_str() {
        Some("runway-image") => runway::image_payload(input),
        Some("openai-image") => openai_image::payload(input),
        _ => Err(failure()),
    }
}
fn reserve(db: &Mutex<Connection>, input: &Value, c: &MediaConnection) -> Result<(), String> {
    let id = input["job"]["id"].as_str().ok_or_else(failure)?;
    let registry = media::public_registry()?;
    let descriptor = registry["images"]
        .as_array()
        .ok_or_else(failure)?
        .iter()
        .find(|m| m["id"] == input["media"]["registry_id"])
        .ok_or_else(failure)?;
    let cost = descriptor["cost"]["amount"].as_u64().ok_or_else(failure)?;
    let field = if c.provider == "openai" {
        "reserved_milli_usd"
    } else {
        "reserved_credits"
    };
    update(db, id, |p, j| {
        if j.get("remote").is_some() || j["status"] != "running" || j["media"] != input["media"] {
            return Err("送信済みまたは異なる画像要求です".into());
        }
        let used = p["jobs"]
            .as_array()
            .ok_or_else(failure)?
            .iter()
            .filter(|j| j["remote"]["kind"] == c.adapter_id)
            .fold(0u64, |sum, j| {
                sum.saturating_add(
                    j["remote"][field]
                        .as_u64()
                        .unwrap_or(0)
                        .max(j["remote"]["estimated_milli_usd"].as_u64().unwrap_or(0)),
                )
            });
        if used.saturating_add(cost) > c.max_credits {
            return Err("作品の画像生成予算上限です".into());
        }
        let mut remote = json!({"kind":c.adapter_id,"account":account(c),"model":c.model,"destination":input["output"],"status":"SUBMITTING"});
        remote[field] = json!(cost);
        Ok(remote)
    })?;
    Ok(())
}
pub async fn submit(
    db: &Mutex<Connection>,
    root: &Path,
    input: &Value,
    c: &MediaConnection,
) -> Result<(), String> {
    let selected = media::image_model(input["media"]["registry_id"].as_str())?;
    if !supports(&selected.adapter_id)
        || c.adapter_id != selected.adapter_id
        || c.model != selected.model_id
        || c.provider != selected.provider
    {
        return Err("画像モデルと接続が一致しません".into());
    }
    let body = payload(input)?;
    let id = input["job"]["id"].as_str().ok_or_else(failure)?;
    reserve(db, input, c)?;
    if c.provider == "openai" {
        let result = openai_image::generate(&body, c).await?;
        let bytes = openai_image::decode_result(&result)?;
        // Save the receipt before any optional accounting update or UI handoff.
        storage::image_recovery::store_remote(db, root, id, &bytes)?;
        update(db, id, |_, j| {
            let mut r = j["remote"].clone();
            r["status"] = json!("SUCCEEDED");
            if let Some(cost) = openai_image::estimated_milli_usd(&result, &c.model) {
                r["estimated_milli_usd"] = json!(cost);
            }
            Ok(r)
        })?;
        return Ok(());
    }
    let url = reqwest::Url::parse("https://api.dev.runwayml.com/v1/text_to_image")
        .map_err(|_| failure())?;
    let client = PolicyTransport::external_client(&url).await?;
    let result = runway::json_response(
        runway::request(&client, reqwest::Method::POST, url, c)
            .json(&body)
            .send()
            .await
            .map_err(|_| failure())?,
    )
    .await?;
    let task = result["id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(failure)?;
    update(db, id, |_, j| {
        let mut r = j["remote"].clone();
        r["task_id"] = json!(task);
        r["status"] = json!("PENDING");
        Ok(r)
    })?;
    Ok(())
}

pub async fn collect(
    db: &Mutex<Connection>,
    root: &Path,
    id: &str,
    c: &MediaConnection,
) -> Result<Value, String> {
    let remote = {
        let db = db.lock().map_err(|_| failure())?;
        let p = storage::raw_project(&db)?;
        p["jobs"]
            .as_array()
            .ok_or_else(failure)?
            .iter()
            .find(|j| j["id"] == id)
            .ok_or_else(failure)?["remote"]
            .clone()
    };
    if !supports(&c.adapter_id)
        || remote["kind"] != c.adapter_id
        || remote["account"] != account(c)
        || remote["model"] != c.model
    {
        return Err("生成時と同じサービス・モデル・APIキーを登録してください".into());
    }
    {
        let db = db.lock().map_err(|_| failure())?;
        if let Ok(saved) = storage::image_recovery::recover(&db, root, id) {
            return Ok(saved);
        }
    }
    if c.provider == "openai" {
        return Err(
            "OpenAIの応答画像が未保存です。同期APIのため後から取得できません。自動再送しません"
                .into(),
        );
    }
    let task = remote["task_id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or("送信応答が未確定です。自動再送しません")?;
    let url = {
        let url = reqwest::Url::parse(&format!("https://api.dev.runwayml.com/v1/tasks/{task}"))
            .map_err(|_| failure())?;
        let client = PolicyTransport::external_client(&url).await?;
        let result = runway::json_response(
            runway::request(&client, reqwest::Method::GET, url, c)
                .send()
                .await
                .map_err(|_| failure())?,
        )
        .await?;
        match result["status"].as_str() {
            Some("SUCCEEDED") => {}
            Some("PENDING" | "RUNNING" | "THROTTLED") => {
                return Err(format!(
                    "静止画処理状態: {}",
                    result["status"].as_str().unwrap()
                ))
            }
            _ => return Err(failure()),
        }
        runway::output_url(&result)?
    };
    // Separate unauthenticated CDN request: API credentials never reach output hosts.
    let client = PolicyTransport::external_client(&url).await?;
    let mut response = client.get(url).send().await.map_err(|_| failure())?;
    if !response.status().is_success() {
        return Err(failure());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
        if bytes.len() + chunk.len() > 24 * 1024 * 1024 {
            return Err("画像が大きすぎます".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    storage::image_recovery::store_remote(db, root, id, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn durable_reservation_blocks_resubmit_and_unknown_openai_never_polls() {
        let selected = media::image_model(Some("openai-gpt-image-2-5")).unwrap();
        let c = MediaConnection {
            credential: "fixture-secret".into(),
            max_credits: 1000,
            provider: selected.provider,
            model: selected.model_id.clone(),
            adapter_id: selected.adapter_id.clone(),
        };
        let input = json!({"job":{"id":"first"},"media":{"registry_id":selected.registry_id,"adapter_id":selected.adapter_id,"model_id":selected.model_id}});
        let project = json!({"jobs":[{"id":"first","status":"running","media":input["media"]},{"id":"second","status":"running","media":input["media"]}]});
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE project (id INTEGER PRIMARY KEY,data TEXT);")
            .unwrap();
        db.execute("INSERT INTO project VALUES (1,?1)", [project.to_string()])
            .unwrap();
        let db = Mutex::new(db);
        reserve(&db, &input, &c).unwrap();
        assert!(reserve(&db, &input, &c).unwrap_err().contains("送信済み"));
        let mut second = input.clone();
        second["job"]["id"] = json!("second");
        assert!(reserve(&db, &second, &c).unwrap_err().contains("予算"));
        let saved = storage::raw_project(&db.lock().unwrap()).unwrap();
        assert!(!saved.to_string().contains(&c.credential));
        assert_eq!(saved["jobs"][0]["remote"]["reserved_milli_usd"], 1000);
        assert!(saved["jobs"][1].get("remote").is_none());
        let error = collect(&db, Path::new("/unused-fixture-root"), "first", &c)
            .await
            .unwrap_err();
        assert!(error.contains("同期API"));
    }
}
