//! Thin, same-user file IPC client for the separately installed Compositor build.
//! The editor alone writes working.comp; snapshots reuse project artifact storage.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::time::{sleep, Duration, Instant};
use uuid::Uuid;

const MAX_BYTES: usize = 96 * 1024 * 1024;

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn directory(id: &str) -> Result<PathBuf, String> {
    let id = Uuid::parse_str(id).map_err(error)?.to_string();
    Ok(std::env::temp_dir().join(format!("manga-compositor-{id}")))
}
fn read(path: &Path) -> Result<Value, String> {
    let meta = std::fs::symlink_metadata(path).map_err(error)?;
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Err("Compositorの応答ファイルが不正です".into());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(error)?).map_err(error)
}
fn write(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(error)?;
    if bytes.len() > MAX_BYTES {
        return Err("Compositorの素材容量が上限を超えています".into());
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes).map_err(error)?;
    std::fs::rename(temporary, path).map_err(error)
}
fn connection(dir: &Path, id: &str) -> Result<Value, String> {
    let meta = std::fs::symlink_metadata(dir).map_err(error)?;
    if !meta.is_dir() {
        return Err("Compositorの接続先が不正です".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.mode() & 0o777 != 0o700 || meta.uid() != unsafe { libc::getuid() } {
            return Err("Compositor接続ディレクトリの権限が不正です".into());
        }
    }
    let value = read(&dir.join("connection.json"))?;
    if value["session"].as_str() != Some(id)
        || value["token"].as_str().is_none_or(|s| s.len() != 64)
    {
        return Err("Compositorの接続情報が一致しません".into());
    }
    Ok(value)
}
fn png(uri: &Value) -> Result<Vec<u8>, String> {
    let raw = uri
        .as_str()
        .and_then(|s| s.strip_prefix("data:image/png;base64,"))
        .ok_or("CompositorにはPNG素材が必要です")?;
    if raw.len() > MAX_BYTES {
        return Err("PNG容量が上限を超えています".into());
    }
    let bytes = STANDARD.decode(raw).map_err(error)?;
    if bytes.len() < 33 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("PNGヘッダが不正です".into());
    }
    Ok(bytes)
}
/// Bounded package envelope only; upstream ProjectStore validates actual .comp semantics and PNG pixels.
pub fn validate_bundle(bundle: &Value) -> Result<(), String> {
    let manifest = &bundle["manifest"];
    if manifest["format"] != "com.compositor.project"
        || manifest["version"] != 8
        || manifest["colorSpace"] != "sRGB"
    {
        return Err("未対応のCompositor保存形式です".into());
    }
    let width = manifest["width"].as_u64().ok_or("幅が不正です")?;
    let height = manifest["height"].as_u64().ok_or("高さが不正です")?;
    if width == 0
        || height == 0
        || width > 30_000
        || height > 30_000
        || width * height > 100_000_000
    {
        return Err("Compositorのキャンバス寸法が上限を超えています".into());
    }
    Uuid::parse_str(
        manifest["documentID"]
            .as_str()
            .ok_or("document IDがありません")?,
    )
    .map_err(error)?;
    let layers = manifest["layers"].as_array().ok_or("レイヤーが不正です")?;
    let images = bundle["images"].as_object().ok_or("素材が不正です")?;
    if layers.is_empty()
        || layers.len() > 64
        || images.len() > 128
        || serde_json::to_vec(bundle).map_err(error)?.len() > MAX_BYTES
    {
        return Err("Compositor連携は最大64レイヤー・96MiBです".into());
    }
    let mut expected = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    for layer in layers {
        let id =
            Uuid::parse_str(layer["id"].as_str().ok_or("layer IDがありません")?).map_err(error)?;
        if !ids.insert(id) {
            return Err("レイヤーIDが重複しています".into());
        }
        for (field, suffix) in [("imageFile", ".png"), ("maskFile", ".mask.png")] {
            if layer[field].is_null() {
                continue;
            }
            let filename = format!("{}{suffix}", id.to_string().to_uppercase());
            if layer[field].as_str() != Some(filename.as_str()) {
                return Err("素材名が不正です".into());
            }
            png(&images.get(&filename).ok_or("素材が不足しています")?["image"])?;
            expected.insert(filename);
        }
    }
    if expected.len() != images.len() {
        return Err("参照されていない素材があります".into());
    }
    Ok(())
}

pub async fn start(id: &str, bundle: Value) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("Compositor連携には対応するMacが必要です".into());
    }
    validate_bundle(&bundle)?;
    let dir = directory(id)?;
    // create_new semantics: a lost launch response never launches another editor.
    std::fs::create_dir(&dir)
        .map_err(|_| "この編集セッションは既にあります。再接続してください")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    write(
        &dir.join("connection.json"),
        &json!({"session": id, "token": token}),
    )?;
    let package = dir.join("working.comp");
    std::fs::create_dir_all(package.join("images")).map_err(error)?;
    write(&package.join("manifest.json"), &bundle["manifest"])?;
    for (name, image) in bundle["images"].as_object().ok_or("素材が不正です")? {
        std::fs::write(package.join("images").join(name), png(&image["image"])?).map_err(error)?;
    }
    let home = std::env::var_os("HOME").ok_or("ホームディレクトリがありません")?;
    let app = PathBuf::from(home).join("Applications/Compositor Manga.app");
    if !app.join("Contents/MacOS/Compositor").is_file() {
        return Err("Compositor連携版を ~/Applications/Compositor Manga.app に導入してください（macOS 26.5以降）".into());
    }
    let output = tokio::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg("-a")
        .arg(app)
        .arg("--args")
        .arg("--manga-session")
        .arg(&dir)
        .output()
        .await
        .map_err(error)?;
    if !output.status.success() {
        return Err("Compositorを起動できませんでした".into());
    }
    exchange(id, json!({"op": "open"})).await
}

pub async fn exchange(id: &str, args: Value) -> Result<Value, String> {
    let dir = directory(id)?;
    let config = connection(&dir, id)?;
    let op = args["op"].as_str().ok_or("操作がありません")?;
    let pending = dir.join("pending.json");
    let request_id;
    if op == "recover" {
        request_id = read(&pending)?["id"]
            .as_str()
            .ok_or("照合対象がありません")?
            .to_owned();
    } else {
        if !["open", "state", "claim", "handoff", "transform", "snapshot"].contains(&op) {
            return Err("未対応のCompositor操作です".into());
        }
        if pending.exists() {
            return Err("前の操作が未確定です。再送せず結果を照合してください".into());
        }
        request_id = Uuid::new_v4().to_string();
        let mut request = args.as_object().ok_or("操作が不正です")?.clone();
        request.insert("id".into(), json!(request_id));
        request.insert("protocol".into(), json!(1));
        request.insert("session".into(), json!(id));
        request.insert("token".into(), config["token"].clone());
        write(&pending, &json!({"id": request_id}))?;
        write(&dir.join("request.json"), &Value::Object(request))?;
    }
    Uuid::parse_str(&request_id).map_err(error)?;
    let path = dir.join(format!("{request_id}.json"));
    let deadline = Instant::now() + Duration::from_secs(30);
    while !path.exists() {
        if Instant::now() >= deadline {
            return Err(
                "Compositorの応答が未確定です。操作を再送せず結果を照合してください".into(),
            );
        }
        sleep(Duration::from_millis(100)).await;
    }
    let response = read(&path)?;
    if response["id"].as_str() != Some(&request_id)
        || response["session"].as_str() != Some(id)
        || response["protocol"] != 1
    {
        return Err("Compositor応答の接続情報が一致しません".into());
    }
    let value = &response["value"];
    if response["ok"] == true && !value["bundle"].is_null() {
        validate_bundle(&value["bundle"])?;
        png(&value["image"])?;
        if value["state"]["document"] != value["bundle"]["manifest"]["documentID"] {
            return Err("保存版とドキュメントが一致しません".into());
        }
        // Keep the completed snapshot response for recovery until the existing Job is committed.
        write(&dir.join("snapshot.json"), &response)?;
    }
    std::fs::remove_file(pending).map_err(error)?;
    if response["ok"] != true {
        return Err(format!("Compositor: {}", response["error"]));
    }
    Ok(value.clone())
}

pub fn saved_snapshot(id: &str) -> Result<Value, String> {
    let dir = directory(id)?;
    connection(&dir, id)?;
    let response = read(&dir.join("snapshot.json"))?;
    let value = &response["value"];
    validate_bundle(&value["bundle"])?;
    png(&value["image"])?;
    Ok(value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_rejects_path_traversal_and_duplicate_layers() {
        let id = Uuid::new_v4().to_string().to_uppercase();
        let mut bundle = json!({"manifest": {"format":"com.compositor.project", "version":8,
            "colorSpace":"sRGB", "documentID":id, "width":32, "height":32,
            "layers":[{"id":id}]}, "images":{}});
        validate_bundle(&bundle).unwrap();
        bundle["manifest"]["layers"][0]["imageFile"] = json!("../../outside.png");
        assert!(validate_bundle(&bundle).is_err());
        bundle["manifest"]["layers"] = json!([{"id":id},{"id":id}]);
        assert!(validate_bundle(&bundle).is_err());
    }

    #[tokio::test]
    async fn pending_operation_is_recovered_without_resubmission() {
        let id = Uuid::new_v4().to_string();
        let dir = directory(&id).unwrap();
        std::fs::create_dir(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        write(
            &dir.join("connection.json"),
            &json!({"session":id,"token":"a".repeat(64)}),
        )
        .unwrap();
        let request_id = Uuid::new_v4().to_string();
        write(&dir.join("pending.json"), &json!({"id":request_id})).unwrap();
        assert!(exchange(&id, json!({"op":"transform"}))
            .await
            .unwrap_err()
            .contains("未確定"));
        write(
            &dir.join(format!("{request_id}.json")),
            &json!({"id":request_id,"session":id,"protocol":1,"ok":true,"value":{"revision":2}}),
        )
        .unwrap();
        assert_eq!(
            exchange(&id, json!({"op":"recover"})).await.unwrap()["revision"],
            2
        );
        assert!(!dir.join("request.json").exists());
        assert!(!dir.join("pending.json").exists());
        assert!(exchange(&id, json!({"op":"shell"})).await.is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
