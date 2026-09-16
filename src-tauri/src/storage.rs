use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

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
pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS project(id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_backups(hash TEXT PRIMARY KEY,data TEXT NOT NULL);",
    )
    .map_err(err)
}
pub fn save(db: &mut Connection, root: &Path, data: &str) -> Result<()> {
    let mut project: Value = serde_json::from_str(data).map_err(err)?;
    if !matches!(project["version"].as_u64(), Some(1 | 2 | 3)) {
        return Err("Unsupported project schema".into());
    }
    // Commit the previous exact JSON before starting file migration.
    let previous: Option<String> = db
        .query_row("SELECT data FROM project WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(err)?;
    let backup = previous.as_deref().unwrap_or(data);
    db.execute(
        "INSERT OR IGNORE INTO project_backups(hash,data) VALUES(?1,?2)",
        [&hash(backup.as_bytes()), backup],
    )
    .map_err(err)?;
    let dir = root.join("artifacts");
    externalize(&mut project, &dir)?;
    // Read-back validation is also required for already existing references.
    let mut checked = project.clone();
    hydrate(&mut checked, &dir)?;
    sync_dir(root)?;
    let tx = db.transaction().map_err(err)?;
    tx.execute("INSERT INTO project(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [project.to_string()]).map_err(err)?;
    tx.commit().map_err(err)
}
pub fn load(db: &Connection, root: &Path) -> Result<Option<String>> {
    let data: Option<String> = db
        .query_row("SELECT data FROM project WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(err)?;
    data.map(|data| {
        let mut value: Value = serde_json::from_str(&data).map_err(err)?;
        hydrate(&mut value, &root.join("artifacts"))?;
        Ok(value.to_string())
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "manga-storage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let db = Connection::open(dir.join("test.sqlite3")).unwrap();
        initialize(&db).unwrap();
        (db, dir)
    }
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/legacy-v1.json")).unwrap()
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
        project["localizations"] = json!([{"locale":"en","snapshot_id":"source","units":[{"id":"u1","text":"Hello"}]}]);
        save(&mut db, &dir, &project.to_string()).unwrap();
        let restored: Value = serde_json::from_str(&load(&db, &dir).unwrap().unwrap()).unwrap();
        assert_eq!(restored, project);
        fs::remove_dir_all(dir).unwrap();
    }

}
