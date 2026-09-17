#[path = "backup.rs"]
pub mod backup;
#[path = "draft.rs"]
pub mod draft;
#[path = "image_recovery.rs"]
pub mod image_recovery;
#[path = "layout.rs"]
pub mod layout;
#[path = "lettering.rs"]
pub mod lettering;
#[path = "source_library.rs"]
pub mod source_library;
#[path = "source_refs.rs"]
pub mod source_refs;

#[path = "live_export.rs"]
pub mod live_export;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn sync_dir(dir: &Path) -> Result<()> {
    fs::File::open(dir).and_then(|f| f.sync_all()).map_err(err)
}

// Content addressing plus no-clobber publication. A crash leaves an unreferenced
// temporary file or a verified immutable file; never a dangling adopted pointer.
fn put(dir: &Path, bytes: &[u8]) -> Result<String> {
    fs::create_dir_all(dir).map_err(err)?;
    let id = hash(bytes);
    let path = dir.join(&id);
    if path.exists() {
        verify(dir, &id)?;
        return Ok(id);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_nanos();
    let temp = dir.join(format!(".pending-{}-{stamp}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(err)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(err)?;
    if hash(&fs::read(&temp).map_err(err)?) != id {
        return Err("Artifact verification failed".into());
    }
    match fs::hard_link(&temp, &path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            verify(dir, &id)?;
        }
        Err(e) => return Err(err(e)),
    }
    fs::remove_file(temp).map_err(err)?;
    sync_dir(dir)?;
    verify(dir, &id)?;
    Ok(id)
}
fn verify(dir: &Path, id: &str) -> Result<Vec<u8>> {
    if !valid_hash(id) {
        return Err("Invalid artifact ID".into());
    }
    let path = dir.join(id);
    if fs::symlink_metadata(&path)
        .map_err(err)?
        .file_type()
        .is_symlink()
    {
        return Err("Artifact symlink rejected".into());
    }
    let bytes = fs::read(path).map_err(err)?;
    if hash(&bytes) != id {
        return Err("Artifact hash mismatch; adopted data was not changed".into());
    }
    Ok(bytes)
}
fn image_field(key: &str) -> bool {
    matches!(key, "image" | "original" | "mask")
}
fn externalize(value: &mut Value, dir: &Path) -> Result<()> {
    match value {
        Value::Array(items) => {
            for item in items {
                externalize(item, dir)?;
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                if image_field(key) {
                    if let Some(uri) = item.as_str().filter(|s| s.starts_with("data:image/")) {
                        let (prefix, encoded) = uri.split_once(',').ok_or("Invalid image")?;
                        if ![
                            "data:image/png;base64",
                            "data:image/jpeg;base64",
                            "data:image/webp;base64",
                        ]
                        .contains(&prefix)
                        {
                            return Err("Unsupported image type".into());
                        }
                        let bytes = STANDARD
                            .decode(encoded)
                            .map_err(|_| "Invalid image encoding")?;
                        let id = put(dir, &bytes)?;
                        *item = json!({"artifact_id": id, "hash": id, "prefix": prefix, "size": bytes.len()});
                    } else if item.get("artifact_id").is_some() {
                        read_image(item, dir)?;
                    }
                }
                externalize(item, dir)?;
            }
        }
        _ => (),
    }
    Ok(())
}
fn read_image(item: &Value, dir: &Path) -> Result<String> {
    let id = item["artifact_id"]
        .as_str()
        .ok_or("Invalid artifact reference")?;
    if item["hash"].as_str() != Some(id) {
        return Err("Artifact reference mismatch".into());
    }
    let prefix = item["prefix"].as_str().ok_or("Invalid image prefix")?;
    if ![
        "data:image/png;base64",
        "data:image/jpeg;base64",
        "data:image/webp;base64",
    ]
    .contains(&prefix)
    {
        return Err("Invalid image prefix".into());
    }
    let bytes = verify(dir, id)?;
    if item["size"].as_u64() != Some(bytes.len() as u64) {
        return Err("Artifact size mismatch".into());
    }
    Ok(format!("{prefix},{}", STANDARD.encode(bytes)))
}
fn hydrate(value: &mut Value, dir: &Path) -> Result<()> {
    match value {
        Value::Array(items) => {
            for item in items {
                hydrate(item, dir)?;
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                if image_field(key) && item.get("artifact_id").is_some() {
                    *item = Value::String(read_image(item, dir)?);
                } else {
                    hydrate(item, dir)?;
                }
            }
        }
        _ => (),
    }
    Ok(())
}

pub const MAX_VIDEO_BYTES: u64 = 128 * 1024 * 1024;

fn media_dir(root: &Path) -> Result<PathBuf> {
    let dir = root.join("media");
    fs::create_dir_all(&dir).map_err(err)?;
    if fs::symlink_metadata(&dir)
        .map_err(err)?
        .file_type()
        .is_symlink()
    {
        return Err("Media directory symlink rejected".into());
    }
    Ok(dir)
}

// Container bounds only. The platform video decoder remains responsible for
// playback/codec validation; this is not a second media decoding engine.
fn check_mp4(file: &mut fs::File, size: u64) -> Result<()> {
    if !(32..=MAX_VIDEO_BYTES).contains(&size) {
        return Err("Invalid video size".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(err)?;
    let mut offset = 0_u64;
    let mut boxes = 0;
    let (mut ftyp, mut moov, mut mdat) = (false, false, false);
    while offset < size {
        boxes += 1;
        if boxes > 4096 || size - offset < 8 {
            return Err("Invalid MP4 structure".into());
        }
        let mut header = [0_u8; 8];
        file.read_exact(&mut header).map_err(err)?;
        let mut length = u32::from_be_bytes(header[..4].try_into().map_err(err)?) as u64;
        let mut header_size = 8;
        if length == 1 {
            let mut extended = [0_u8; 8];
            file.read_exact(&mut extended).map_err(err)?;
            length = u64::from_be_bytes(extended);
            header_size = 16;
        } else if length == 0 {
            length = size - offset;
        }
        if length < header_size || length > size - offset {
            return Err("Truncated MP4 box".into());
        }
        match &header[4..] {
            b"ftyp" => {
                if offset != 0 || length < 16 {
                    return Err("Invalid MP4 type".into());
                }
                ftyp = true;
            }
            b"moov" => moov = length > header_size,
            b"mdat" => mdat = length > header_size,
            _ => (),
        }
        offset += length;
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
    }
    if !(ftyp && moov && mdat) {
        return Err("MP4 is missing required boxes".into());
    }
    Ok(())
}

fn file_hash(file: &mut fs::File) -> Result<String> {
    file.seek(SeekFrom::Start(0)).map_err(err)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    let mut size = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(err)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_VIDEO_BYTES {
            return Err("Video exceeds size limit".into());
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn verify_video(root: &Path, artifact: &Value) -> Result<PathBuf> {
    let id = artifact["hash"].as_str().ok_or("Missing video hash")?;
    let size = artifact["size"].as_u64().ok_or("Missing video size")?;
    if !valid_hash(id)
        || artifact["artifact_id"].as_str() != Some(id)
        || artifact["mime"].as_str() != Some("video/mp4")
        || !(32..=MAX_VIDEO_BYTES).contains(&size)
    {
        return Err("Invalid video reference".into());
    }
    let path = media_dir(root)?.join(format!("{id}.mp4"));
    if !fs::symlink_metadata(&path)
        .map_err(err)?
        .file_type()
        .is_file()
    {
        return Err("Video is not a regular file".into());
    }
    let mut file = fs::File::open(&path).map_err(err)?;
    if file.metadata().map_err(err)?.len() != size {
        return Err("Video size mismatch".into());
    }
    check_mp4(&mut file, size)?;
    if file_hash(&mut file)? != id {
        return Err("Video hash mismatch".into());
    }
    Ok(path)
}

// Used by provider collection and native fixtures, never an arbitrary-path IPC.
pub fn put_video(root: &Path, mut input: impl Read, expected_hash: Option<&str>) -> Result<Value> {
    let dir = media_dir(root)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_nanos();
    let temp = dir.join(format!(".pending-{}-{stamp}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(&temp)
        .map_err(err)?;
    let result = (|| {
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 65536];
        let mut size = 0_u64;
        loop {
            let count = input.read(&mut buffer).map_err(err)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > MAX_VIDEO_BYTES {
                return Err("Video exceeds size limit".into());
            }
            file.write_all(&buffer[..count]).map_err(err)?;
            hash.update(&buffer[..count]);
        }
        file.sync_all().map_err(err)?;
        let id = format!("{:x}", hash.finalize());
        if expected_hash.is_some_and(|h| h != id) {
            return Err("Downloaded video hash mismatch".into());
        }
        check_mp4(&mut file, size)?;
        if file_hash(&mut file)? != id {
            return Err("Video read-back mismatch".into());
        }
        let artifact = json!({"artifact_id":id,"hash":id,"mime":"video/mp4","size":size});
        let path = dir.join(format!("{id}.mp4"));
        match fs::hard_link(&temp, path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(err(e)),
        }
        sync_dir(&dir)?;
        verify_video(root, &artifact)?;
        Ok(artifact)
    })();
    drop(file);
    let _ = fs::remove_file(temp);
    result
}

pub fn video_reference(db: &Connection, revision_id: &str) -> Result<Value> {
    let data: String = db
        .query_row("SELECT data FROM project WHERE id=1", [], |r| r.get(0))
        .map_err(err)?;
    let project: Value = serde_json::from_str(&data).map_err(err)?;
    let revision = project["videoRevisions"]
        .as_array()
        .ok_or("No video revisions")?
        .iter()
        .find(|v| v["id"].as_str() == Some(revision_id))
        .ok_or("Unknown video revision")?;
    Ok(revision["artifact"].clone())
}

pub fn export_video(root: &Path, downloads: &Path, artifact: &Value) -> Result<PathBuf> {
    let source = verify_video(root, artifact)?;
    fs::create_dir_all(downloads).map_err(err)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_nanos();
    let target = downloads.join(format!("{stamp}-video.mp4"));
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(&target)
        .map_err(err)?;
    let result = (|| {
        let mut input = fs::File::open(source)
            .map_err(err)?
            .take(MAX_VIDEO_BYTES + 1);
        let count = std::io::copy(&mut input, &mut output).map_err(err)?;
        if Some(count) != artifact["size"].as_u64() {
            return Err("Video changed during export".into());
        }
        output.sync_all().map_err(err)?;
        if Some(file_hash(&mut output)?.as_str()) != artifact["hash"].as_str() {
            return Err("Export hash mismatch".into());
        }
        sync_dir(downloads)?;
        Ok(target.clone())
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(target);
    }
    result
}

fn check_video_references(project: &Value, root: &Path) -> Result<()> {
    if let Some(revisions) = project.get("videoRevisions") {
        for revision in revisions.as_array().ok_or("Invalid video revisions")? {
            verify_video(root, &revision["artifact"])?;
        }
    }
    Ok(())
}
pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS project(id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_backups(hash TEXT PRIMARY KEY,data TEXT NOT NULL);",
    )
    .map_err(err)
}
fn remove_legacy_confirmation(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("confirmedThroughPanelId");
        for key in ["history", "editRedo"] {
            if let Some(entries) = object.get_mut(key).and_then(Value::as_array_mut) {
                for entry in entries {
                    remove_legacy_confirmation(entry);
                }
            }
        }
        if let Some(after) = object.get_mut("after") {
            remove_legacy_confirmation(after);
        }
    }
}
pub fn save(db: &mut Connection, root: &Path, data: &str) -> Result<()> {
    let mut project: Value = serde_json::from_str(data).map_err(err)?;
    remove_legacy_confirmation(&mut project);
    if !matches!(project["version"].as_u64(), Some(1..=5)) {
        return Err("Unsupported project schema".into());
    }
    source_refs::validate(&project)?;
    draft::validate(&project)?;
    if let Some(panels) = project["panels"].as_array() {
        for panel in panels {
            if let Some(value) = panel.get("lettering") {
                let legacy_ids = if panel.get("sourceRefs").is_some() {
                    serde_json::json!([])
                } else {
                    panel["unitIds"].clone()
                };
                let ids = legacy_ids
                    .as_array()
                    .ok_or("Missing source units")?
                    .iter()
                    .map(|v| v.as_str().ok_or_else(|| "Invalid source unit".to_string()))
                    .collect::<Result<Vec<_>>>()?;
                lettering::validate(
                    value,
                    if panel.get("sourceRefs").is_some() {
                        None
                    } else {
                        Some(&ids)
                    },
                )?;
            }
        }
    }
    if let Some(pages) = project.get("layout") {
        let ids = project["panels"]
            .as_array()
            .ok_or("Missing panels")?
            .iter()
            .filter_map(|p| p["id"].as_str())
            .collect();
        layout::validate(pages, Some(&ids))?;
    }
    if let Some(jobs) = project.get("jobs") {
        let mut ids = std::collections::HashSet::new();
        for job in jobs.as_array().ok_or("Invalid jobs")? {
            let id = job["id"].as_str().ok_or("Missing job ID")?;
            if id.is_empty() || !ids.insert(id) {
                return Err("Duplicate job ID".into());
            }
        }
    }
    // Commit the previous exact JSON before starting file migration.
    let previous: Option<String> = db
        .query_row("SELECT data FROM project WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(err)?;
    let backup = previous.as_deref().unwrap_or(data);
    if let Some(old) = previous.as_deref() {
        let old_project: Value = serde_json::from_str(old).map_err(err)?;
        if old_project.get("layout").is_some() && project.get("layout").is_none() {
            return Err("Page layout requires a compatible app version".into());
        }
        if old_project["version"].as_u64() == Some(5) && project["version"].as_u64() != Some(5) {
            return Err("Source references require a compatible app version".into());
        }
        for old_panel in old_project["panels"].as_array().into_iter().flatten() {
            if old_panel.get("sourceRefs").is_some() {
                if let Some(next) = project["panels"]
                    .as_array()
                    .and_then(|ps| ps.iter().find(|p| p["id"] == old_panel["id"]))
                {
                    if next.get("sourceRefs").is_none() {
                        return Err(
                            "Source references cannot be discarded by an older editor".into()
                        );
                    }
                }
            }
        }
        for snapshot in old_project["snapshots"].as_array().into_iter().flatten() {
            if snapshot["scenes"]
                .as_array()
                .is_some_and(|ss| ss.iter().any(|s| s.get("sourceHash").is_some()))
            {
                let next = project["snapshots"]
                    .as_array()
                    .and_then(|ss| ss.iter().find(|s| s["id"] == snapshot["id"]));
                if next != Some(snapshot) {
                    return Err("Immutable source snapshot cannot be replaced".into());
                }
            }
        }
        preserve_remote_jobs(&old_project, &mut project)?;
    }
    db.execute(
        "INSERT OR IGNORE INTO project_backups(hash,data) VALUES(?1,?2)",
        [&hash(backup.as_bytes()), backup],
    )
    .map_err(err)?;
    let dir = root.join("artifacts");
    externalize(&mut project, &dir)?;
    check_video_references(&project, root)?;
    // Read-back validation is also required for already existing references.
    let mut checked = project.clone();
    hydrate(&mut checked, &dir)?;
    sync_dir(root)?;
    let tx = db.transaction().map_err(err)?;
    tx.execute("INSERT INTO project(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [project.to_string()]).map_err(err)?;
    tx.commit().map_err(err)
}

// An old UI snapshot must not erase task IDs, submitted markers or reserved cost.
fn preserve_remote_jobs(old: &Value, next: &mut Value) -> Result<()> {
    if let Some(jobs) = old["jobs"].as_array() {
        for job in jobs
            .iter()
            .filter(|j| j.get("remote").is_some() || j.get("local_image").is_some())
        {
            let target = next["jobs"]
                .as_array_mut()
                .ok_or("Missing jobs")?
                .iter_mut()
                .find(|j| j["id"] == job["id"])
                .ok_or("Submitted jobs cannot be removed")?;
            for field in [
                "manifest",
                "panelId",
                "kind",
                "input_hash",
                "scope",
                "base_revision",
                "source_revision",
                "active_snapshot",
                "placement_key",
                "finishing",
            ] {
                if target[field] != job[field] {
                    return Err("Submitted job inputs are immutable".into());
                }
            }
            for key in ["remote", "local_image"] {
                if let Some(value) = job.get(key) {
                    target[key] = value.clone();
                }
            }
        }
    }
    Ok(())
}

pub fn raw_project(db: &Connection) -> Result<Value> {
    let data: String = db
        .query_row("SELECT data FROM project WHERE id=1", [], |r| r.get(0))
        .map_err(err)?;
    serde_json::from_str(&data).map_err(err)
}

// Native transport metadata lives on the existing job, not in a parallel queue.
pub fn update_remote_job(
    db: &mut Connection,
    id: &str,
    update: impl FnOnce(&Value, &Value) -> Result<Value>,
) -> Result<Value> {
    let tx = db.transaction().map_err(err)?;
    let mut project = raw_project(&tx)?;
    let index = project["jobs"]
        .as_array()
        .ok_or("Missing jobs")?
        .iter()
        .position(|j| j["id"].as_str() == Some(id))
        .ok_or("Job must be saved before submission")?;
    let remote = update(&project, &project["jobs"][index])?;
    project["jobs"][index]["remote"] = remote.clone();
    tx.execute(
        "UPDATE project SET data=?1 WHERE id=1",
        [project.to_string()],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(remote)
}
pub fn load(db: &Connection, root: &Path) -> Result<Option<String>> {
    let data: Option<String> = db
        .query_row("SELECT data FROM project WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(err)?;
    data.map(|data| {
        let mut value: Value = serde_json::from_str(&data).map_err(err)?;
        remove_legacy_confirmation(&mut value);
        hydrate(&mut value, &root.join("artifacts"))?;
        // A missing video must not make the user's entire manga unreadable.
        // Playback/adoption/export verify the individual artifact on demand.
        Ok(value.to_string())
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn setup() -> (Connection, std::path::PathBuf) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = loop {
            let suffix = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("manga-storage-{}-{suffix}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => break path,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("Cannot reserve test directory: {error}"),
            }
        };
        let db = Connection::open(dir.join("test.sqlite3")).unwrap();
        initialize(&db).unwrap();
        (db, dir)
    }
    #[test]
    fn obsolete_boundary_is_removed_from_saved_history_without_changing_art() {
        let (mut db, dir) = setup();
        let mut p = fixture();
        p["confirmedThroughPanelId"] = json!("old-panel");
        p["history"][0]["confirmedThroughPanelId"] = json!("old-panel");
        save(&mut db, &dir, &p.to_string()).unwrap();
        let restored: Value = serde_json::from_str(&load(&db, &dir).unwrap().unwrap()).unwrap();
        assert!(restored.get("confirmedThroughPanelId").is_none());
        assert!(restored["history"][0]
            .get("confirmedThroughPanelId")
            .is_none());
        assert_eq!(restored["panels"], p["panels"]);
        assert_eq!(restored["snapshots"], p["snapshots"]);
        fs::remove_dir_all(dir).unwrap();
    }
    pub(super) fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/legacy-v1.json")).unwrap()
    }
    fn video_fixture() -> Vec<u8> {
        STANDARD
            .decode(include_str!("../../tests/fixtures/video-blue.mp4.base64").trim())
            .unwrap()
    }
    #[test]
    fn layout_roundtrip_rejects_corruption_and_old_app_downgrade() {
        let (mut db, dir) = setup();
        let mut p = fixture();
        save(&mut db, &dir, &p.to_string()).unwrap();
        let old = p.clone();
        p["layout"] = json!({"version":1,"knownPanelIds":[p["panels"][0]["id"]],"pages":[{"id":"page","slots":[{"id":"s","panelId":p["panels"][0]["id"],"points":[[0.1,0.1],[0.9,0.1],[0.8,0.9],[0.2,0.9]]}]}]});
        p["layoutHistory"] = json!([]);
        p["layoutRedo"] = json!([]);
        save(&mut db, &dir, &p.to_string()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&load(&db, &dir).unwrap().unwrap()).unwrap()["layout"],
            p["layout"]
        );
        assert!(save(&mut db, &dir, &old.to_string()).is_err());
        p["layout"]["pages"][0]["slots"][0]["points"][2] = json!([2, 2]);
        assert!(save(&mut db, &dir, &p.to_string()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn source_ranges_roundtrip_and_reject_downgrade_and_snapshot_rewrite() {
        let (mut db, dir) = setup();
        let mut p = fixture();
        let old = p.clone();
        p["version"] = json!(5);
        p["sourceApplication"] = json!({"version":1,"units":[]});
        for snapshot in p["snapshots"].as_array_mut().unwrap() {
            for scene in snapshot["scenes"].as_array_mut().unwrap() {
                scene["sourceHash"] = json!(hash(scene["text"].as_str().unwrap().as_bytes()));
            }
        }
        let snapshot = &p["snapshots"][0];
        let r = json!({"snapshotId":snapshot["id"],"sceneId":snapshot["scenes"][0]["id"],"startCp":0,"endCp":1});
        p["panels"][0]["sourceRefs"] = json!([r]);
        save(&mut db, &dir, &p.to_string()).unwrap();
        let before = load(&db, &dir).unwrap();
        assert!(save(&mut db, &dir, &old.to_string()).is_err());
        let mut missing = p.clone();
        missing["panels"][0]
            .as_object_mut()
            .unwrap()
            .remove("sourceRefs");
        assert!(save(&mut db, &dir, &missing.to_string()).is_err());
        let mut changed = p.clone();
        changed["snapshots"][0]["scenes"][0]["text"] = json!("rewritten");
        changed["snapshots"][0]["scenes"][0]["sourceHash"] = json!(hash(b"rewritten"));
        assert!(save(&mut db, &dir, &changed.to_string()).is_err());
        assert_eq!(load(&db, &dir).unwrap(), before);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stale_ui_cannot_erase_task_id_cost_or_mutate_submitted_input() {
        let (mut db, dir) = setup();
        let mut original = fixture();
        original["jobs"] = json!([{"id":"v","scope":{"type":"videoShot","id":"shot"},"manifest":{"prompt":"original"},"input_hash":"h","status":"running"}]);
        save(&mut db, &dir, &original.to_string()).unwrap();
        let remote = json!({"status":"PENDING","task_id":"task","reserved_credits":60});
        update_remote_job(&mut db, "v", |_, _| Ok(remote.clone())).unwrap();
        // A stale snapshot has no remote field at all, but saving it preserves native metadata.
        save(&mut db, &dir, &original.to_string()).unwrap();
        assert_eq!(raw_project(&db).unwrap()["jobs"][0]["remote"], remote);
        original["jobs"][0]["manifest"]["prompt"] = json!("changed");
        assert!(save(&mut db, &dir, &original.to_string()).is_err());
        original["jobs"] = json!([]);
        assert!(save(&mut db, &dir, &original.to_string()).is_err());
        drop(db);
        let db = Connection::open(dir.join("test.sqlite3")).unwrap();
        assert_eq!(raw_project(&db).unwrap()["jobs"][0]["remote"], remote);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn video_stream_roundtrip_export_and_restart() {
        let (mut db, dir) = setup();
        let bytes = video_fixture();
        let artifact = put_video(&dir, bytes.as_slice(), Some(&hash(&bytes))).unwrap();
        assert_eq!(put_video(&dir, bytes.as_slice(), None).unwrap(), artifact);
        let mut project = fixture();
        project["version"] = json!(4);
        project["videoRevisions"] = json!([{"id":"v1","artifact":artifact}]);
        save(&mut db, &dir, &project.to_string()).unwrap();
        drop(db);
        let db = Connection::open(dir.join("test.sqlite3")).unwrap();
        let stored = video_reference(&db, "v1").unwrap();
        assert_eq!(stored, artifact);
        assert!(video_reference(&db, "../outside").is_err());
        let export = export_video(&dir, &dir.join("exports"), &stored).unwrap();
        assert_eq!(fs::read(export).unwrap(), bytes);
        assert_eq!(
            serde_json::from_str::<Value>(&load(&db, &dir).unwrap().unwrap()).unwrap(),
            project
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn interrupted_corrupt_and_oversize_video_never_change_project() {
        let (mut db, dir) = setup();
        let original = fixture();
        save(&mut db, &dir, &original.to_string()).unwrap();
        let bytes = video_fixture();
        assert!(put_video(&dir, bytes.as_slice(), Some(&"0".repeat(64))).is_err());
        assert!(put_video(&dir, &bytes[..bytes.len() - 1], None).is_err());
        assert!(put_video(&dir, std::io::repeat(0).take(MAX_VIDEO_BYTES + 1), None).is_err());
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("interrupted"))
            }
        }
        assert!(put_video(&dir, Broken, None).is_err());
        assert_eq!(fs::read_dir(dir.join("media")).unwrap().count(), 0);
        let artifact = put_video(&dir, bytes.as_slice(), None).unwrap();
        let path = verify_video(&dir, &artifact).unwrap();
        fs::write(&path, vec![0; bytes.len()]).unwrap();
        assert!(verify_video(&dir, &artifact).is_err());
        assert!(export_video(&dir, &dir.join("exports"), &artifact).is_err());
        let mut changed = original.clone();
        changed["videoRevisions"] = json!([{"id":"bad","artifact":artifact}]);
        assert!(save(&mut db, &dir, &changed.to_string()).is_err());
        assert_eq!(
            serde_json::from_str::<Value>(&load(&db, &dir).unwrap().unwrap()).unwrap(),
            original
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn draft_checkpoint_artifacts_roundtrip_and_invalid_scope_preserves_saved_work() {
        let (mut db, dir) = setup();
        let mut p = fixture();
        p["layout"] = json!({"version":1,"pages":[]});
        p["snapshots"] = json!([{"id":"source","scenes":[{"id":"scene"}]}]);
        p["draftScope"] = json!({"id":"draft","snapshotId":"source","sceneIds":["scene"]});
        p["history"] = json!([{"id":"checkpoint","draftCheckpoint":true,"active":"source","panels":p["panels"],"layout":p["layout"],"draftScope":p["draftScope"]}]);
        p["panels"] = json!([]);
        save(&mut db, &dir, &p.to_string()).unwrap();
        let stored: String = db
            .query_row("SELECT data FROM project", [], |r| r.get(0))
            .unwrap();
        assert!(!stored.contains("base64,"));
        let mut corrupt = p.clone();
        corrupt["history"][0]["draftScope"]["sceneIds"] = json!(["missing"]);
        assert!(save(&mut db, &dir, &corrupt.to_string()).is_err());
        drop(db);
        let db = Connection::open(dir.join("test.sqlite3")).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&load(&db, &dir).unwrap().unwrap()).unwrap(),
            p
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_restart_and_history_roundtrip() {
        let (mut db, dir) = setup();
        let original = fixture();
        db.execute("INSERT INTO project VALUES(1,?1)", [original.to_string()])
            .unwrap();
        save(&mut db, &dir, &original.to_string()).unwrap();
        let stored: String = db
            .query_row("SELECT data FROM project", [], |r| r.get(0))
            .unwrap();
        assert!(!stored.contains("base64,"));
        drop(db);
        let db = Connection::open(dir.join("test.sqlite3")).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&load(&db, &dir).unwrap().unwrap()).unwrap(),
            original
        );
        assert_eq!(
            db.query_row::<String, _, _>("SELECT data FROM project_backups", [], |r| r.get(0))
                .unwrap(),
            original.to_string()
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn interruption_reuses_files_and_preserves_previous_json() {
        let (mut db, dir) = setup();
        let original = fixture();
        db.execute("INSERT INTO project VALUES(1,?1)", [original.to_string()])
            .unwrap();
        let mut broken = original.clone();
        broken["panels"][0]["image"] = json!("data:image/png;base64,!");
        assert!(save(&mut db, &dir, &broken.to_string()).is_err());
        assert_eq!(
            serde_json::from_str::<Value>(&load(&db, &dir).unwrap().unwrap()).unwrap(),
            original
        );
        save(&mut db, &dir, &original.to_string()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&load(&db, &dir).unwrap().unwrap()).unwrap(),
            original
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn corrupt_artifact_never_advances_database() {
        let (mut db, dir) = setup();
        let original = fixture();
        save(&mut db, &dir, &original.to_string()).unwrap();
        let before: String = db
            .query_row("SELECT data FROM project", [], |r| r.get(0))
            .unwrap();
        let stored: Value = serde_json::from_str(&before).unwrap();
        let id = stored["panels"][0]["image"]["artifact_id"]
            .as_str()
            .unwrap();
        fs::write(dir.join("artifacts").join(id), b"corrupt").unwrap();
        assert!(load(&db, &dir).is_err());
        assert!(save(&mut db, &dir, &original.to_string()).is_err());
        assert_eq!(
            db.query_row::<String, _, _>("SELECT data FROM project", [], |r| r.get(0))
                .unwrap(),
            before
        );
        assert!(verify(&dir, "../outside").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn version_three_localization_survives_native_save_and_reload() {
        let (mut db, dir) = setup();
        let mut project = fixture();
        project["version"] = json!(3);
        project["output_locale"] = json!("en");
        project["localizations"] =
            json!([{"locale":"en","snapshot_id":"source","units":[{"id":"u1","text":"Hello"}]}]);
        save(&mut db, &dir, &project.to_string()).unwrap();
        let restored: Value = serde_json::from_str(&load(&db, &dir).unwrap().unwrap()).unwrap();
        assert_eq!(restored, project);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn video_schema_roundtrip_preserves_manifest_without_hydrating_video() {
        let (mut db, dir) = setup();
        let mut project = fixture();
        project["version"] = json!(4);
        project["videoShots"] = json!([{"id":"v1","snapshotId":"source","startImage":{"kind":"artwork","id":"a1","hash":"fixed"}}]);
        project["videoRevisions"] = json!([]);
        project["videoHistory"] = json!([]);
        project["jobs"].as_array_mut().unwrap().push(json!({"id":"video-job","scope":{"type":"videoShot","id":"v1"},"status":"unknown","manifest":{"providerInputs":[{"role":"start_frame","media_type":"image","hash":"fixed"}]}}));
        save(&mut db, &dir, &project.to_string()).unwrap();
        let restored: Value = serde_json::from_str(&load(&db, &dir).unwrap().unwrap()).unwrap();
        assert_eq!(restored, project);
        project["version"] = json!(5);
        assert!(save(&mut db, &dir, &project.to_string()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
