//! Read-only compatibility for fixed captures saved by earlier app versions.
//! Never starts Blender or alters legacy workspaces.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
fn error() -> String {
    "保存済み撮影画像を確認できませんでした".into()
}
fn hash(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|_| error())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|_| error())?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
pub fn capture(
    db: &rusqlite::Connection,
    root: &Path,
    session_id: &str,
    request_id: &str,
) -> Result<Value, String> {
    if !valid_id(request_id) {
        return Err(error());
    }
    let recorded: String = db
        .query_row(
            "SELECT result FROM blender_jobs WHERE id=?1 AND session_id=?2 AND status='complete'",
            rusqlite::params![request_id, session_id],
            |r| r.get(0),
        )
        .map_err(|_| error())?;
    let folder = root.join("blender").join(request_id);
    let verified = verify_output(&folder)?;
    let expected: Value = serde_json::from_str(&recorded).map_err(|_| error())?;
    if verified != expected
        || verified["image"].is_null()
        || verified["dependencies_pinned"] != true
    {
        return Err("版固定済みの撮影成果物ではありません".into());
    }
    Ok(
        json!({"session_id":session_id,"request_id":request_id,"state":verified,"preview":preview(&folder)?}),
    )
}

fn preview(folder: &Path) -> Result<String, String> {
    use base64::Engine;
    use std::io::Read;
    let path = folder.join("capture.png");
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| error())?;
    const LIMIT: u64 = 80 * 1024 * 1024;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > LIMIT {
        return Err("Blenderプレビューの形式またはサイズが不正です".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| error())?
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error())?;
    if bytes.len() as u64 > LIMIT || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Blenderプレビューの形式またはサイズが不正です".into());
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
fn verify_output(folder: &Path) -> Result<Value, String> {
    let path = folder.join("result.json");
    if std::fs::symlink_metadata(&path)
        .map_err(|_| error())?
        .file_type()
        .is_symlink()
        || std::fs::metadata(&path).map_err(|_| error())?.len() > 1024 * 1024
    {
        return Err(error());
    }
    let result: Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| error())?).map_err(|_| error())?;
    if result["protocol"] != 1 || result["blender_version"] != json!([4, 5, 13]) {
        return Err("未対応のBlender版・接続形式です".into());
    }
    for (key, name) in [("checkpoint", "checkpoint.blend"), ("image", "capture.png")] {
        if key == "image" && result[key].is_null() {
            continue;
        }
        let path = folder.join(name);
        if result[key]["file"] != name
            || std::fs::symlink_metadata(&path)
                .map_err(|_| error())?
                .file_type()
                .is_symlink()
            || result[key]["hash"] != hash(&path)?
        {
            return Err("Blender成果物の検証に失敗しました".into());
        }
    }
    if !result["image"].is_null() {
        preview(folder)?;
    }
    Ok(result)
}
