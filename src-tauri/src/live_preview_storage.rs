// Local private checkpoint; never placed in the transferable asset allow-list.
use super::{err, hash, raw_project, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub fn directory(root: &Path, revision: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(revision).map_err(|_| "Invalid preview revision")?;
    Ok(root.join("previews").join(revision))
}
fn write_new(path: &Path, value: &Value) -> Result<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(err)?;
    f.write_all(&serde_json::to_vec(value).map_err(err)?)
        .and_then(|_| f.sync_all())
        .map_err(err)
}
fn exact(value: &Value, keys: &[&str]) -> Result<()> {
    let map = value.as_object().ok_or("Expected preview object")?;
    if map.len() != keys.len() || keys.iter().any(|k| !map.contains_key(*k)) {
        return Err("Unexpected preview field".into());
    }
    Ok(())
}
fn validate_metadata(preview: &Value) -> Result<()> {
    exact(
        preview,
        &[
            "format",
            "schemaVersion",
            "savedAt",
            "manifest",
            "scenes",
            "panels",
        ],
    )?;
    if preview["format"] != "live-manga-preview" || preview["schemaVersion"] != "1.0.0" {
        return Err("Invalid preview schema".into());
    }
    let scenes = preview["scenes"]
        .as_array()
        .filter(|a| a.len() <= 3200)
        .ok_or("Invalid preview scenes")?;
    let mut scene_ids = std::collections::HashSet::new();
    for scene in scenes {
        exact(scene, &["id", "tags"])?;
        let id = scene["id"].as_str().ok_or("Invalid scene ID")?;
        if id.trim().is_empty()
            || id.chars().count() > 256
            || id.chars().any(|c| c.is_control() || c == '<' || c == '>')
            || !scene_ids.insert(id)
        {
            return Err("Invalid scene ID".into());
        }
        for tag in scene["tags"]
            .as_array()
            .filter(|a| a.len() <= 64)
            .ok_or("Invalid tags")?
        {
            let tag = tag.as_str().ok_or("Invalid tag")?;
            if tag.trim().is_empty()
                || tag.chars().count() > 80
                || tag.chars().any(char::is_control)
            {
                return Err("Invalid tag".into());
            }
        }
    }
    let pages = preview["manifest"]["pages"]
        .as_array()
        .ok_or("Missing pages")?;
    let published: Vec<&Value> = pages
        .iter()
        .flat_map(|p| p["panels"].as_array().into_iter().flatten())
        .collect();
    let rows = preview["panels"]
        .as_array()
        .filter(|a| a.len() <= 3200)
        .ok_or("Invalid metadata")?;
    if rows.len() != published.len() {
        return Err("Missing panel metadata".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut used = std::collections::HashSet::new();
    for row in rows {
        exact(row, &["id", "sceneIds", "art", "lettering", "motion"])?;
        let id = row["id"].as_str().ok_or("Invalid panel")?;
        let panel = published
            .iter()
            .find(|p| p["id"] == id)
            .ok_or("Unknown panel")?;
        if !seen.insert(id)
            || !matches!(row["art"].as_str(), Some("ready" | "pending"))
            || !matches!(
                row["lettering"].as_str(),
                Some("ready" | "pending" | "none")
            )
            || !matches!(
                row["motion"].as_str(),
                Some("ready" | "pending" | "stale" | "none")
            )
        {
            return Err("Invalid panel status".into());
        }
        if panel.get("motion").is_some() != (row["motion"] == "ready")
            || (row["art"] == "pending" && panel.get("motion").is_some())
            || (row["lettering"] == "none" && panel["text"] != "")
        {
            return Err("Inconsistent status".into());
        }
        let mut refs = std::collections::HashSet::new();
        for scene in row["sceneIds"]
            .as_array()
            .filter(|a| a.len() <= 64)
            .ok_or("Invalid scene refs")?
        {
            let id = scene.as_str().ok_or("Invalid scene ref")?;
            if !scene_ids.contains(id) || !refs.insert(id) {
                return Err("Invalid scene ref".into());
            }
            used.insert(id);
        }
    }
    if used != scene_ids {
        return Err("Unrelated scene metadata".into());
    }
    Ok(())
}
pub fn capture(db: &Connection, root: &Path, revision: u64, saved_at: &str) -> Result<Value> {
    let project = raw_project(db)?;
    if project["revision"].as_u64() != Some(revision) {
        return Err("保存版が変わりました。もう一度転送してください".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = directory(root, &id)?;
    fs::create_dir_all(&dir).map_err(err)?;
    write_new(
        &dir.join("snapshot.json"),
        &json!({"project":project,"savedAt":saved_at}),
    )?;
    super::sync_dir(&dir)?;
    Ok(json!({"revision":id,"savedAt":saved_at}))
}
pub fn stage(root: &Path, request: &Value) -> Result<Value> {
    let preview = &request["preview"];
    validate_metadata(preview)?;
    let m = &preview["manifest"];
    let id = m["releaseId"].as_str().ok_or("Missing preview revision")?;
    let dir = directory(root, id)?;
    let frozen: Value =
        serde_json::from_slice(&fs::read(dir.join("snapshot.json")).map_err(err)?).map_err(err)?;
    let project = &frozen["project"];
    if preview["savedAt"] != frozen["savedAt"] || m["workId"] != project["workId"] {
        return Err("保存版と転送内容が一致しません".into());
    }
    let active = project["snapshots"]
        .as_array()
        .ok_or("Missing snapshots")?
        .iter()
        .find(|s| s["id"] == project["active"]);
    let episode = active
        .and_then(|s| s["episodeId"].as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("publication");
    if m["episodeId"] != episode {
        return Err("転送先の話が一致しません".into());
    }
    let bytes = serde_json::to_vec(preview).map_err(err)?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("Preview too large".into());
    }
    let destination = dir.join(format!("live-manga-{id}"));
    if destination.exists() {
        let previous = fs::read(destination.join("preview.json")).map_err(err)?;
        if previous != bytes {
            return Err("転送版は上書きできません".into());
        }
    } else {
        super::live_export::export_snapshot(
            root,
            &dir,
            &json!({"manifest":m,"preview":preview,"sources":request["sources"],"projectRevision":project["revision"]}),
            project,
        )?;
        super::sync_dir(&destination)?;
    }
    Ok(json!({"revision":id,"digest":hash(&bytes)}))
}
pub fn video_probe(root: &Path, revision: &str, video: &str) -> Result<Value> {
    let frozen: Value = serde_json::from_slice(
        &fs::read(directory(root, revision)?.join("snapshot.json")).map_err(err)?,
    )
    .map_err(err)?;
    let artifact = &frozen["project"]["videoRevisions"]
        .as_array()
        .ok_or("Missing frozen videos")?
        .iter()
        .find(|v| v["id"] == video)
        .ok_or("Unknown frozen video")?["artifact"];
    let path = super::verify_video(root, artifact)?;
    let meta = super::live_export::probe(&path)?;
    if meta["codec"] != "h264"
        || meta["audio"] != false
        || meta["duration"]
            .as_f64()
            .is_none_or(|d| d <= 0.0 || d > 30.0)
    {
        return Err("Preview video profile is unsupported".into());
    }
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_pins_saved_revision_and_rejects_paths() {
        let root = std::env::temp_dir().join(format!("preview-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        super::super::initialize(&db).unwrap();
        let project = json!({"version":4,"revision":1,"panels":[],"history":[],"artworks":[],"jobs":[],"videoShots":[],"videoRevisions":[]});
        super::super::save(&mut db, &root, &project.to_string()).unwrap();
        assert!(capture(&db, &root, 2, "2026-09-17T00:00:00.000Z").is_err());
        let receipt = capture(&db, &root, 1, "2026-09-17T00:00:00.000Z").unwrap();
        let path = directory(&root, receipt["revision"].as_str().unwrap())
            .unwrap()
            .join("snapshot.json");
        let before = fs::read(&path).unwrap();
        let mut next = project.clone();
        next["revision"] = json!(2);
        super::super::save(&mut db, &root, &next.to_string()).unwrap();
        assert_eq!(fs::read(path).unwrap(), before);
        assert!(directory(&root, "../secret").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preview_metadata_never_accepts_unknown_fields() {
        let mut p = json!({"format":"live-manga-preview","schemaVersion":"1.0.0","savedAt":"2026-09-17T00:00:00.000Z","manifest":{"pages":[]},"panels":[],"scenes":[]});
        assert!(validate_metadata(&p).is_ok());
        p["token"] = json!("secret");
        assert!(validate_metadata(&p).is_err());
        p.as_object_mut().unwrap().remove("token");
        p["scenes"] = json!([{"id":"a","tags":[],"rawSource":"secret"}]);
        assert!(validate_metadata(&p).is_err());
    }
}
