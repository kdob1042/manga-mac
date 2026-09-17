// Publication boundary: existing immutable media + layer PNGs; no generated API calls.
use super::{err, hash, raw_project, valid_hash, verify_video, video_reference, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, process::Command};
pub(crate) fn probe(path: &Path) -> Result<Value> {
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
// Defense at the native publication boundary; the vendored contracts remain canonical.
fn clip_geometry(panel: &Value, w: f64, h: f64, frame: [f64; 4], art: [f64; 4]) -> Result<()> {
    let points = panel["clip"].as_array().ok_or("Missing clip")?;
    if points.len() != 4 {
        return Err("Clip requires four vertices".into());
    }
    let mut q = [[0.0; 2]; 4];
    for (i, point) in points.iter().enumerate() {
        let pair = point.as_array().ok_or("Invalid clip vertex")?;
        if pair.len() != 2 {
            return Err("Invalid clip vertex".into());
        }
        for j in 0..2 {
            let n = pair[j].as_f64().ok_or("Invalid clip coordinate")?;
            if !n.is_finite() || n < 0.0 || n > [w, h][j] {
                return Err("Clip outside page".into());
            }
            q[i][j] = n;
        }
    }
    let cross = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    };
    if (0..4).any(|i| cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]) / (w * h) <= 1e-8) {
        return Err("Clip must be clockwise and convex".into());
    }
    let min_x = q.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
    let min_y = q.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
    let max_x = q.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
    let max_y = q.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max);
    let [fx, fy, fw, fh] = frame;
    if [fx - min_x, fy - min_y, fx + fw - max_x, fy + fh - max_y]
        .iter()
        .any(|n| n.abs() > 0.001)
    {
        return Err("Frame must bound clip".into());
    }
    let [x, y, rw, rh] = art;
    let covers = x <= fx + 0.001
        && y <= fy + 0.001
        && x + rw >= fx + fw - 0.001
        && y + rh >= fy + fh - 0.001;
    let contained = [[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]]
        .iter()
        .all(|p| (0..4).all(|i| cross(q[i], q[(i + 1) % 4], *p) >= -0.001));
    if !covers && !contained {
        return Err("Art must cover frame or fit inside clip".into());
    }
    Ok(())
}
fn geometry(m: &Value) -> Result<()> {
    let v2 = m["schemaVersion"] == "2.0.0";
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
                let transformed = v2 && name == "artRect";
                if values.iter().any(|n| !n.is_finite())
                    || rw <= 0.0
                    || rh <= 0.0
                    || if transformed {
                        values.iter().any(|n| n.abs() > (w.max(h) as f64) * 65536.0)
                    } else {
                        x < 0.0 || y < 0.0 || x + rw > w as f64 + 0.001 || y + rh > h as f64 + 0.001
                    }
                {
                    return Err("Rectangle out of bounds".into());
                }
                boxes.push(values);
            }
            let [x, y, rw, rh] = boxes[1];
            let [fx, fy, fw, fh] = boxes[0];
            if v2 {
                clip_geometry(panel, w as f64, h as f64, boxes[0], boxes[1])?;
            } else if x < fx || y < fy || x + rw > fx + fw + 0.001 || y + rh > fy + fh + 0.001 {
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
    if m["format"] != "live-manga"
        || !matches!(m["schemaVersion"].as_str(), Some("1.0.0" | "2.0.0"))
    {
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
                if m["schemaVersion"] == "2.0.0" {
                    &["id", "frame", "artRect", "poster", "text", "motion", "clip"]
                } else {
                    &["id", "frame", "artRect", "poster", "text", "motion"]
                },
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
    if request.get("preview").is_some() {
        return Err("Preview requires private staging".into());
    }
    let project = raw_project(db)?;
    export_snapshot(root, downloads, request, &project)
}

pub fn export_snapshot(
    root: &Path,
    downloads: &Path,
    request: &Value,
    project: &Value,
) -> Result<Value> {
    if project["revision"] != request["projectRevision"] {
        return Err("作品が更新されました。もう一度書き出してください".into());
    }
    let manifest = &request["manifest"];
    public_fields(manifest)?;
    if manifest["schemaVersion"] == "1.0.0" {
        super::layout::require_legacy_live_layout(project)?;
    } else if let Some(layout) = project.get("layout") {
        let panels = project["panels"]
            .as_array()
            .ok_or("Missing project panels")?;
        let ids = panels.iter().filter_map(|p| p["id"].as_str()).collect();
        super::layout::validate(layout, Some(&ids))?;
        let authored: Vec<&Value> = layout["pages"]
            .as_array()
            .ok_or("Missing layout pages")?
            .iter()
            .filter(|p| {
                request.get("preview").is_none()
                    || p["slots"].as_array().is_some_and(|s| !s.is_empty())
            })
            .collect();
        let published = manifest["pages"].as_array().ok_or("Missing public pages")?;
        if authored.len() != published.len() {
            return Err("Publication layout mismatch".into());
        }
        let mut order = Vec::new();
        for (source, page) in authored.iter().zip(published) {
            let slots = source["slots"].as_array().ok_or("Missing slots")?;
            let output = page["panels"].as_array().ok_or("Missing public panels")?;
            if slots.len() != output.len() || page["width"] != 1600 || page["height"] != 2260 {
                return Err("Publication layout mismatch".into());
            }
            for (slot, panel) in slots.iter().zip(output) {
                let empty_preview = request.get("preview").is_some() && slot["panelId"].is_null();
                if if empty_preview {
                    panel["id"]
                        != format!(
                            "preview-slot:{}",
                            slot["id"].as_str().ok_or("Missing slot ID")?
                        )
                } else {
                    slot["panelId"].is_null() || slot["panelId"] != panel["id"]
                } {
                    return Err("Publication assignment mismatch".into());
                }
                if !empty_preview {
                    order.push(panel["id"].clone());
                }
                for i in 0..4 {
                    for (j, scale) in [1600.0, 2260.0].iter().enumerate() {
                        let expected = slot["points"][i][j]
                            .as_f64()
                            .ok_or("Invalid source point")?
                            * scale;
                        if panel["clip"][i][j]
                            .as_f64()
                            .is_none_or(|n| (n - expected).abs() > 0.001)
                        {
                            return Err("Publication clip mismatch".into());
                        }
                    }
                }
            }
        }
        let expected: Vec<Value> = panels
            .iter()
            .filter(|p| request.get("preview").is_none() || order.contains(&p["id"]))
            .map(|p| p["id"].clone())
            .collect();
        if order != expected {
            return Err("Publication reading order mismatch".into());
        }
    }
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
                let artifact = project["videoRevisions"]
                    .as_array()
                    .ok_or("Missing videos")?
                    .iter()
                    .find(|v| v["id"] == revision)
                    .ok_or("Unknown frozen video")?["artifact"]
                    .clone();
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
        if let Some(preview) = request.get("preview") {
            let mut out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.join("preview.json"))
                .map_err(err)?;
            out.write_all(&serde_json::to_vec(preview).map_err(err)?)
                .and_then(|_| out.sync_all())
                .map_err(err)?;
        }
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
        Ok(
            json!({"releaseId":release,"path":destination,"schemaVersion":manifest["schemaVersion"],"bytes":total}),
        )
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
        let mut v2 = request.clone();
        v2["manifest"]["schemaVersion"] = json!("2.0.0");
        v2["manifest"]["releaseId"] = json!(uuid::Uuid::new_v4().to_string());
        v2["manifest"]["pages"][0]["panels"][0]["clip"] = json!([[0, 0], [1, 0], [1, 1], [0, 1]]);
        v2["manifest"]["pages"][0]["panels"][0]["artRect"] =
            json!({"x":-0.5,"y":-0.5,"width":2,"height":2});
        let v2_result = export(&db, &dir, &out, &v2).unwrap();
        assert_eq!(v2_result["schemaVersion"], "2.0.0");
        assert!(export(&db, &dir, &out, &v2).is_err());
        for mutation in [
            "missing",
            "clockwise",
            "outside",
            "bounds",
            "transform",
            "private",
            "v1",
        ] {
            let mut bad = v2.clone();
            bad["manifest"]["releaseId"] = json!(uuid::Uuid::new_v4().to_string());
            let panel = &mut bad["manifest"]["pages"][0]["panels"][0];
            match mutation {
                "missing" => {
                    panel.as_object_mut().unwrap().remove("clip");
                }
                "clockwise" => panel["clip"] = json!([[0, 0], [0, 1], [1, 1], [1, 0]]),
                "outside" => panel["clip"][0][0] = json!(-1),
                "bounds" => panel["frame"]["width"] = json!(0.8),
                "transform" => panel["artRect"]["x"] = json!(-1e12),
                "private" => panel["artRect"]["prompt"] = json!("private"),
                _ => bad["manifest"]["schemaVersion"] = json!("1.0.0"),
            }
            assert!(export(&db, &dir, &out, &bad).is_err(), "{mutation}");
        }
        assert_eq!(fs::read_dir(&out).unwrap().count(), 2);
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
        for mutate in ["shape", "assignment", "count"] {
            let mut bad = payload["request"].clone();
            match mutate {
                "shape" => bad["manifest"]["pages"][0]["panels"][0]["clip"][0][0] = json!(1),
                "assignment" => bad["manifest"]["pages"][0]["panels"][0]["id"] = json!("other"),
                _ => {
                    bad["manifest"]["pages"].as_array_mut().unwrap().pop();
                }
            }
            assert!(export(&db, &dir, &out, &bad).is_err());
        }
        let result = export(&db, &dir, &out, &payload["request"]).unwrap();
        println!("LIVE_MANGA_PACKAGE={}", result["path"]);
        fs::remove_dir_all(dir).unwrap();
    }
}
