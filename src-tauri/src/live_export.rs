// Publication boundary: existing immutable media + layer PNGs; no generated API calls.
use super::{err, hash, raw_project, valid_hash, verify_video, video_reference, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, process::Command};
fn probe(path: &Path) -> Result<Value> {
    let temp = std::env::temp_dir().join(format!("manga-probe-{}", uuid::Uuid::new_v4()));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(err)?;
    let executable = [
        "/opt/homebrew/bin/ffprobe",
        "/usr/local/bin/ffprobe",
        "/usr/bin/ffprobe",
    ]
    .into_iter()
    .find(|p| Path::new(p).is_file())
    .unwrap_or("ffprobe");
    let result = (|| {
        let mut child = Command::new(executable)
            .args([
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-max_alloc",
                "33554432",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(path)
            .stdout(file)
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| "ffprobeが必要です。FFmpegを導入して再試行してください".to_string())?;
        let started = std::time::Instant::now();
        loop {
            if started.elapsed().as_secs() >= 30
                || fs::metadata(&temp).map_err(err)?.len() > 1024 * 1024
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err("メディア検証が上限を超えました".into());
            }
            if let Some(status) = child.try_wait().map_err(err)? {
                if !status.success() {
                    return Err("メディアを検証できません".into());
                }
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        fs::read(&temp).map_err(err)
    })();
    let _ = fs::remove_file(temp);
    let output = result?;
    let info: Value = serde_json::from_slice(&output).map_err(err)?;
    let streams = info["streams"].as_array().ok_or("Missing streams")?;
    let visuals: Vec<_> = streams
        .iter()
        .filter(|s| s["codec_type"] == "video")
        .collect();
    if visuals.len() != 1 {
        return Err("Exactly one visual stream required".into());
    }
    let v = visuals[0];
    Ok(
        json!({"width":v["width"],"height":v["height"],"codec":v["codec_name"],"audio":streams.iter().any(|s| s["codec_type"]=="audio"),"duration":info["format"]["duration"].as_str().and_then(|s|s.parse::<f64>().ok()).unwrap_or(0.0)}),
    )
}
pub fn video_probe(db: &Connection, root: &Path, revision: &str) -> Result<Value> {
    let artifact = video_reference(db, revision)?;
    let path = verify_video(root, &artifact)?;
    let meta = probe(&path)?;
    if meta["codec"] != "h264"
        || meta["audio"] != false
        || !(0.0..=30.0).contains(&meta["duration"].as_f64().unwrap_or(-1.0))
    {
        return Err("初期公開はH.264・無音・30秒以内です".into());
    }
    Ok(meta)
}
fn keys(v: &Value, allowed: &[&str]) -> Result<()> {
    if v.as_object()
        .ok_or("Expected object")?
        .keys()
        .any(|k| !allowed.contains(&k.as_str()))
    {
        return Err("Unexpected public field".into());
    }
    Ok(())
}
fn geometry(m: &Value) -> Result<()> {
    let assets = m["assets"].as_array().ok_or("Missing assets")?;
    let pages = m["pages"].as_array().ok_or("Missing pages")?;
    if pages.is_empty() || pages.len() > 100 {
        return Err("Invalid page count".into());
    }
    let mut used = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    let mut resolve = |id: &Value, image: bool| -> Result<&Value> {
        let key = id.as_str().ok_or("Missing reference")?;
        let a = assets
            .iter()
            .find(|a| a["id"] == key)
            .ok_or("Unresolved asset")?;
        if a["mime"]
            .as_str()
            .is_none_or(|s| s.starts_with("image/") != image)
        {
            return Err("Wrong asset kind".into());
        }
        used.insert(key.to_string());
        Ok(a)
    };
    for page in pages {
        if !ids.insert(page["id"].as_str().ok_or("Missing page ID")?.to_string()) {
            return Err("Duplicate ID".into());
        }
        let w = page["width"].as_u64().ok_or("Missing width")?;
        let h = page["height"].as_u64().ok_or("Missing height")?;
        if !(1..=8192).contains(&w) || !(1..=8192).contains(&h) {
            return Err("Page bounds exceeded".into());
        }
        for name in ["art", "overlay", "fallback"] {
            let a = resolve(&page[name], true)?;
            if a["width"] != w
                || a["height"] != h
                || (name == "overlay" && a["mime"] != "image/png")
            {
                return Err("Layer dimensions or type mismatch".into());
            }
        }
        let panels = page["panels"].as_array().ok_or("Missing panels")?;
        if panels.is_empty() || panels.len() > 32 {
            return Err("Invalid panel count".into());
        }
        for panel in panels {
            if !ids.insert(panel["id"].as_str().ok_or("Missing panel ID")?.to_string()) {
                return Err("Duplicate ID".into());
            }
            let text = panel["text"].as_str().ok_or("Missing text")?;
            if text.trim().is_empty() || text.chars().count() > 2000 || text.contains(['<', '>']) {
                return Err("Invalid public text".into());
            }
            let mut boxes = Vec::new();
            for name in ["frame", "artRect"] {
                let r = &panel[name];
                let values =
                    ["x", "y", "width", "height"].map(|k| r[k].as_f64().unwrap_or(f64::NAN));
                let [x, y, rw, rh] = values;
                if values.iter().any(|n| !n.is_finite())
                    || x < 0.0
                    || y < 0.0
                    || rw <= 0.0
                    || rh <= 0.0
                    || x + rw > w as f64 + 0.001
                    || y + rh > h as f64 + 0.001
                {
                    return Err("Rectangle out of bounds".into());
                }
                boxes.push(values);
            }
            let [x, y, rw, rh] = boxes[1];
            let [fx, fy, fw, fh] = boxes[0];
            if x < fx || y < fy || x + rw > fx + fw + 0.001 || y + rh > fy + fh + 0.001 {
                return Err("Art outside frame".into());
            }
            let a = resolve(&panel["poster"], true)?;
            let aw = a["width"].as_f64().ok_or("Missing poster width")?;
            let ah = a["height"].as_f64().ok_or("Missing poster height")?;
            if (aw / ah - rw / rh).abs() > 0.001 {
                return Err("Poster ratio mismatch".into());
            }
            if let Some(motion) = panel.get("motion") {
                let v = resolve(&motion["asset"], false)?;
                if motion["end"] != "poster"
                    || v["width"].as_f64().unwrap_or(-1.0) * ah
                        != v["height"].as_f64().unwrap_or(-1.0) * aw
                {
                    return Err("Motion mismatch".into());
                }
            }
        }
    }
    if used.len() != assets.len() {
        return Err("Unreferenced or duplicate asset".into());
    }
    Ok(())
}
fn public_fields(m: &Value) -> Result<()> {
    keys(
        m,
        &[
            "format",
            "schemaVersion",
            "releaseId",
            "workId",
            "episodeId",
            "title",
            "language",
            "pages",
            "assets",
        ],
    )?;
    if m["format"] != "live-manga" || m["schemaVersion"] != "1.0.0" {
        return Err("Unsupported contract".into());
    }
    for page in m["pages"].as_array().ok_or("Missing pages")? {
        keys(
            page,
            &[
                "id", "width", "height", "art", "overlay", "fallback", "panels",
            ],
        )?;
        for panel in page["panels"].as_array().ok_or("Missing panels")? {
            keys(
                panel,
                &["id", "frame", "artRect", "poster", "text", "motion"],
            )?;
            for name in ["frame", "artRect"] {
                keys(&panel[name], &["x", "y", "width", "height"])?;
            }
            if let Some(motion) = panel.get("motion") {
                keys(motion, &["asset", "end"])?;
            }
        }
    }
    Ok(())
}
pub fn export(db: &Connection, root: &Path, downloads: &Path, request: &Value) -> Result<Value> {
    let project = raw_project(db)?;
    super::layout::require_legacy_live_layout(&project)?;
    if project["revision"] != request["projectRevision"] {
        return Err("作品が更新されました。もう一度書き出してください".into());
    }
    let manifest = &request["manifest"];
    public_fields(manifest)?;
    geometry(manifest)?;
    let release = manifest["releaseId"].as_str().ok_or("Missing release")?;
    if uuid::Uuid::parse_str(release).is_err() {
        return Err("Invalid release ID".into());
    }
    let assets = manifest["assets"].as_array().ok_or("Missing assets")?;
    if assets.is_empty()
        || assets.len() > 4000
        || serde_json::to_vec(manifest).map_err(err)?.len() > 4 * 1024 * 1024
    {
        return Err("Package bounds exceeded".into());
    }
    fs::create_dir_all(downloads).map_err(err)?;
    let destination = downloads.join(format!("live-manga-{release}"));
    if destination.exists() {
        return Err("刊行版は上書きできません".into());
    }
    let staging = downloads.join(format!(".live-manga-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(err)?;
    fs::create_dir(staging.join("assets")).map_err(err)?;
    let result = (|| {
        let mut total = 0u64;
        for asset in assets {
            keys(
                asset,
                &[
                    "id", "path", "sha256", "mime", "bytes", "width", "height", "duration",
                    "codec", "audio",
                ],
            )?;
            let id = asset["sha256"].as_str().ok_or("Missing hash")?;
            if !valid_hash(id) || asset["id"] != id {
                return Err("Invalid asset ID".into());
            }
            let mime = asset["mime"].as_str().ok_or("Missing MIME")?;
            let ext = match mime {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                "video/mp4" => "mp4",
                _ => return Err("Unsupported MIME".into()),
            };
            let relative = format!("assets/{id}.{ext}");
            if asset["path"] != relative {
                return Err("Unsafe asset path".into());
            }
            let size = asset["bytes"].as_u64().ok_or("Missing byte size")?;
            let max = if ext == "mp4" {
                128 * 1024 * 1024
            } else {
                32 * 1024 * 1024
            };
            if size == 0 || size > max {
                return Err("Asset bounds exceeded".into());
            }
            total += size;
            if total > 1024 * 1024 * 1024 {
                return Err("Package too large".into());
            }
            for dimension in ["width", "height"] {
                if asset[dimension]
                    .as_u64()
                    .is_none_or(|n| !(1..=8192).contains(&n))
                {
                    return Err("Invalid asset dimensions".into());
                }
            }
            if ext == "mp4"
                && asset["duration"]
                    .as_f64()
                    .is_none_or(|n| !n.is_finite() || n <= 0.0 || n > 30.0)
            {
                return Err("Video duration out of bounds".into());
            }
            let target = staging.join(relative);
            let source = &request["sources"][id];
            if ext == "mp4" {
                keys(source, &["videoRevision"])?;
                let revision = source["videoRevision"]
                    .as_str()
                    .ok_or("Missing video revision")?;
                let artifact = video_reference(db, revision)?;
                if artifact["hash"] != id || artifact["size"] != size {
                    return Err("Video revision mismatch".into());
                }
                let input = verify_video(root, &artifact)?;
                let mut reader = fs::File::open(input).map_err(err)?;
                let mut writer = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(err)?;
                if std::io::copy(&mut reader, &mut writer).map_err(err)? != size {
                    return Err("Incomplete video copy".into());
                }
                writer.sync_all().map_err(err)?;
            } else {
                keys(source, &["image"])?;
                let data = source["image"].as_str().ok_or("Missing image")?;
                let encoded = data
                    .strip_prefix(&format!("data:{mime};base64,"))
                    .ok_or("Image MIME mismatch")?;
                if encoded.len() > max as usize * 4 / 3 + 4 {
                    return Err("Image too large".into());
                }
                let bytes = STANDARD.decode(encoded).map_err(err)?;
                if bytes.len() as u64 != size || hash(&bytes) != id {
                    return Err("Image hash mismatch".into());
                }
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(err)?;
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(err)?;
            }
            let mut file = fs::File::open(&target).map_err(err)?;
            if super::file_hash(&mut file)? != id {
                return Err("Asset hash mismatch after copy".into());
            }
            let meta = probe(&target)?;
            let expected = match ext {
                "png" => "png",
                "jpg" => "mjpeg",
                "webp" => "webp",
                _ => "h264",
            };
            if meta["codec"] != expected
                || meta["width"] != asset["width"]
                || meta["height"] != asset["height"]
            {
                return Err("Actual dimensions or codec mismatch".into());
            }
            if ext == "mp4"
                && (meta["audio"] != false
                    || asset["audio"] != false
                    || asset["codec"] != "h264"
                    || (meta["duration"].as_f64().unwrap_or(-1.0)
                        - asset["duration"].as_f64().unwrap_or(-100.0))
                    .abs()
                        > 0.05)
            {
                return Err("Actual video profile mismatch".into());
            }
        }
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(staging.join("live-manga.json"))
            .map_err(err)?;
        out.write_all(&serde_json::to_vec_pretty(manifest).map_err(err)?)
            .and_then(|_| out.sync_all())
            .map_err(err)?;
        super::sync_dir(&staging.join("assets"))?;
        super::sync_dir(&staging)?;
        // All exporters use random UUID releases; the exclusive reservation prevents concurrent publication.
        let reservation = downloads.join(format!(".reserve-{release}"));
        let lock = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&reservation)
            .map_err(err)?;
        let publish = if destination.exists() {
            Err("Release exists".into())
        } else {
            fs::rename(&staging, &destination).map_err(err)
        };
        drop(lock);
        let _ = fs::remove_file(reservation);
        publish?;
        super::sync_dir(downloads)?;
        Ok(json!({"releaseId":release,"path":destination,"schemaVersion":"1.0.0","bytes":total}))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verified_atomic_export_rejects_changes_and_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("live-export-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        super::super::initialize(&db).unwrap();
        let bytes = STANDARD
            .decode(
                include_str!("../../tests/fixtures/video-blue.mp4.base64")
                    .split_whitespace()
                    .collect::<String>(),
            )
            .unwrap();
        let artifact = super::super::put_video(&dir, bytes.as_slice(), None).unwrap();
        let project = json!({"version":4,"revision":1,"panels":[],"history":[],"artworks":[],"jobs":[],"videoShots":[],"videoRevisions":[{"id":"video1","artifact":artifact}]});
        super::super::save(&mut db, &dir, &project.to_string()).unwrap();
        let meta = video_probe(&db, &dir, "video1").unwrap();
        let id = artifact["hash"].as_str().unwrap();
        let release = uuid::Uuid::new_v4().to_string();
        let mut asset = json!({"id":id,"sha256":id,"path":format!("assets/{id}.mp4"),"mime":"video/mp4","bytes":artifact["size"]});
        for (k, v) in meta.as_object().unwrap() {
            asset[k] = v.clone();
        }
        let legacy: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/legacy-v1.json")).unwrap();
        let image = legacy["panels"][0]["image"].as_str().unwrap();
        let png = STANDARD.decode(image.split(',').nth(1).unwrap()).unwrap();
        let image_id = hash(&png);
        let rect = json!({"x":0,"y":0,"width":1,"height":1});
        let image_asset = json!({"id":image_id,"sha256":image_id,"path":format!("assets/{image_id}.png"),"mime":"image/png","bytes":png.len(),"width":1,"height":1});
        let request = json!({"projectRevision":1,"sources":{id:{"videoRevision":"video1"},image_id.clone():{"image":image}},"manifest":{"format":"live-manga","schemaVersion":"1.0.0","releaseId":release,"workId":"test","episodeId":"one","title":"Test","language":"ja","pages":[{"id":"page","width":1,"height":1,"art":image_id,"overlay":image_id,"fallback":image_id,"panels":[{"id":"panel","frame":rect,"artRect":rect,"poster":image_id,"text":"test","motion":{"asset":id,"end":"poster"}}]}],"assets":[asset,image_asset]}});
        let out = dir.join("out");
        let published = export(&db, &dir, &out, &request).unwrap();
        let published_dir = std::path::PathBuf::from(published["path"].as_str().unwrap());
        assert_eq!(
            fs::read(published_dir.join(format!("assets/{id}.mp4"))).unwrap(),
            bytes
        );
        assert!(export(&db, &dir, &out, &request).is_err());
        for patch in ["hash", "dimension", "private", "revision"] {
            let mut bad = request.clone();
            bad["manifest"]["releaseId"] = json!(uuid::Uuid::new_v4().to_string());
            match patch {
                "hash" => bad["manifest"]["assets"][0]["sha256"] = json!("0".repeat(64)),
                "dimension" => bad["manifest"]["assets"][0]["width"] = json!(999),
                "private" => bad["manifest"]["api_key"] = json!("private"),
                _ => bad["projectRevision"] = json!(2),
            }
            assert!(export(&db, &dir, &out, &bad).is_err());
        }
        assert_eq!(fs::read_dir(&out).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "requires scripts/live-e2e.mjs browser output; run explicitly"]
    fn browser_export_request_integration() {
        let input =
            std::env::var("LIVE_MANGA_E2E_REQUEST").expect("browser exporter input required");
        let payload: Value = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("live-manga-e2e-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        super::super::initialize(&db).unwrap();
        let bytes = STANDARD.decode(payload["video"].as_str().unwrap()).unwrap();
        super::super::put_video(&dir, bytes.as_slice(), None).unwrap();
        super::super::save(&mut db, &dir, &payload["project"].to_string()).unwrap();
        let out = std::path::PathBuf::from(std::env::var("LIVE_MANGA_E2E_OUTPUT").unwrap());
        let result = export(&db, &dir, &out, &payload["request"]).unwrap();
        println!("LIVE_MANGA_PACKAGE={}", result["path"]);
        fs::remove_dir_all(dir).unwrap();
    }
}
