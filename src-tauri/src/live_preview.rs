use crate::{policy_transport::PolicyTransport, storage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};
use tokio_util::io::ReaderStream;
type Result<T> = std::result::Result<T, String>;
static CANCELLED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();
pub fn cancel(revision: &str) -> Result<()> {
    uuid::Uuid::parse_str(revision).map_err(|_| "Invalid revision")?;
    CANCELLED
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Cancel state unavailable")?
        .insert(revision.to_owned());
    Ok(())
}
fn check_cancelled(revision: &str) -> Result<()> {
    if CANCELLED
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Cancel state unavailable")?
        .contains(revision)
    {
        return Err("転送を停止しました。同じ版を再開できます".into());
    }
    Ok(())
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
}
pub fn approved_origin(origin: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(origin).map_err(|_| "転送先が不正です")?;
    if url.scheme() != "https"
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("転送先はHTTPSのWorker originだけを指定してください".into());
    }
    Ok(url)
}
async fn response(mut r: reqwest::Response) -> Result<Value> {
    if !r.status().is_success() {
        return Err(format!(
            "プレビュー転送に失敗しました (HTTP {})。認証・保存先・版の競合を確認してください",
            r.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| "転送結果を取得できません")? {
        if bytes.len() + chunk.len() > 5 * 1024 * 1024 {
            return Err("転送応答が大きすぎます".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "転送応答が不正です".into())
}
async fn status(client: &reqwest::Client, url: &str, token: &str) -> Result<Value> {
    response(
        client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| "転送状態を取得できません")?,
    )
    .await
}
pub async fn send(
    root: &Path,
    revision: &str,
    origin: &str,
    token: &str,
    base: Option<String>,
    scope: (&str, &str),
) -> Result<Value> {
    CANCELLED
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Cancel state unavailable")?
        .remove(revision);
    let origin = approved_origin(origin)?.origin().ascii_serialization();
    if !(43..=128).contains(&token.len())
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("作品・話に限定した転送用キーを入力してください".into());
    }
    if base.as_deref().is_some_and(|id| !safe_id(id)) {
        return Err("基準版IDが不正です".into());
    }
    let dir =
        storage::live_preview::directory(root, revision)?.join(format!("live-manga-{revision}"));
    let preview: Value = serde_json::from_slice(
        &fs::read(dir.join("preview.json")).map_err(|_| "転送準備がありません")?,
    )
    .map_err(|_| "転送準備が不正です")?;
    let m = &preview["manifest"];
    let work = m["workId"]
        .as_str()
        .filter(|id| safe_id(id))
        .ok_or("Invalid work")?;
    let episode = m["episodeId"]
        .as_str()
        .filter(|id| safe_id(id))
        .ok_or("Invalid episode")?;
    if m["releaseId"] != revision {
        return Err("転送版が一致しません".into());
    }
    if (work, episode) != scope {
        return Err("再開する転送は現在の作品・話と異なります".into());
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&preview).map_err(|_| "Invalid preview")?)
    );
    let binding = json!({"origin":origin,"baseRevision":base,"manifestHash":digest});
    let binding_path = dir.join("destination.json");
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&binding_path)
    {
        Ok(mut file) => {
            file.write_all(&serde_json::to_vec(&binding).map_err(|_| "Invalid destination")?)
                .and_then(|_| file.sync_all())
                .map_err(|_| "転送先を保存できません")?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let old: Value = serde_json::from_slice(
                &fs::read(&binding_path).map_err(|_| "転送先を取得できません")?,
            )
            .map_err(|_| "転送先が不正です")?;
            if old != binding {
                return Err(
                    "再開時に転送先や基準版を変更できません。新しい転送を準備してください".into(),
                );
            }
        }
        Err(_) => return Err("転送先を保存できません".into()),
    }
    // Existing transport pins public DNS, disables proxy/redirects and bounds timeouts.
    let client = PolicyTransport::external_client(&approved_origin(&origin)?).await?;
    let url = format!("{origin}/previews/{work}/{episode}/transfers/{revision}");
    response(
        client
            .put(&url)
            .bearer_auth(token)
            .json(&json!({"preview":preview,"baseRevision":base}))
            .send()
            .await
            .map_err(|_| "転送を開始できません。再開できます")?,
    )
    .await?;
    let mut state = status(&client, &url, token).await?;
    if state["committed"] != true {
        let assets = m["assets"].as_array().ok_or("Missing assets")?;
        for missing in state["missing"].as_array().ok_or("Missing status")? {
            check_cancelled(revision)?;
            let asset = assets
                .iter()
                .find(|a| a["id"] == *missing)
                .ok_or("Unknown requested asset")?;
            let id = asset["sha256"].as_str().ok_or("Missing hash")?;
            let mime = asset["mime"].as_str().ok_or("Missing MIME")?;
            let ext = match mime {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                "video/mp4" => "mp4",
                _ => return Err("Invalid MIME".into()),
            };
            if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Invalid hash".into());
            }
            let relative = format!("assets/{id}.{ext}");
            if asset["path"] != relative {
                return Err("Invalid asset path".into());
            }
            let path = dir.join(&relative);
            let mut verify = fs::File::open(&path).map_err(|_| "転送用メディアがありません")?;
            if verify.metadata().map_err(|_| "Missing media")?.len()
                != asset["bytes"].as_u64().ok_or("Missing size")?
                || storage::file_hash(&mut verify)? != id
            {
                return Err("転送用メディアの検証に失敗しました".into());
            }
            let file = tokio::fs::File::open(&path)
                .await
                .map_err(|_| "転送用メディアを開けません")?;
            response(
                client
                    .put(format!("{url}/{relative}"))
                    .bearer_auth(token)
                    .header("Content-Type", mime)
                    .header("Content-Length", asset["bytes"].as_u64().unwrap())
                    .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
                    .send()
                    .await
                    .map_err(|_| "メディア転送が中断しました。再開できます")?,
            )
            .await?;
        }
        check_cancelled(revision)?;
        let commit = client
            .post(format!("{url}/commit"))
            .bearer_auth(token)
            .send()
            .await;
        let commit_result = match commit {
            Ok(r) => response(r).await,
            Err(_) => Err("転送確定の応答がありません".into()),
        };
        state = status(&client, &url, token).await?;
        if state["committed"] != true {
            return Err(commit_result
                .err()
                .unwrap_or("転送が確定していません".into()));
        }
    }
    if state["transferId"] != revision || state["committed"] != true {
        return Err("転送版の確定を確認できません".into());
    }
    // Never trust a remotely supplied redirect, including one with credentials.
    let mut viewer = approved_origin(&origin)?;
    viewer
        .query_pairs_mut()
        .append_pair("preview", &format!("{work}/{episode}"))
        .append_pair("revision", revision);
    let receipt =
        json!({"revision":revision,"viewerUrl":viewer.as_str(),"current":state["current"]});
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("received.json"))
    {
        Ok(mut file) => {
            file.write_all(&serde_json::to_vec(&receipt).map_err(|_| "Invalid receipt")?)
                .and_then(|_| file.sync_all())
                .map_err(|_| {
                    "受信済みですがローカル記録を保存できません。状態を再照会してください"
                })?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => {
            return Err(
                "受信済みですがローカル記録を保存できません。状態を再照会してください".into(),
            )
        }
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_destination_is_an_explicit_https_origin() {
        assert!(approved_origin("https://preview.example.com").is_ok());
        for bad in [
            "http://preview.example.com",
            "https://writer:secret@preview.example.com",
            "https://preview.example.com/path",
            "https://preview.example.com?token=secret",
            "https://preview.example.com#secret",
            "file:///tmp/a",
        ] {
            assert!(approved_origin(bad).is_err(), "{bad}");
        }
        assert!(!safe_id("../other"));
        assert!(!safe_id("a/b"));
        assert!(safe_id("work-1"));
    }
}
