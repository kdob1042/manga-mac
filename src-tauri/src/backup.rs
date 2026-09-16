//! Portable, verified workspace copies. Cloud transport lives in restic.rs.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
#[path = "restic.rs"]
pub mod restic;

pub const FORMAT: u32 = 1;
pub const WEEK: u64 = 7 * 86400;
pub const RETENTION: u64 = 21 * 86400;
pub fn now() -> Result<u64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_secs())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub size: u64,
    pub hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    pub project_schema: u64,
    pub series: String,
    pub created_at: u64,
    pub files: BTreeMap<String, Entry>,
    pub excluded: Vec<String>,
}
pub fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
pub fn regular(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path)
        .map_err(err)?
        .file_type()
        .is_file()
    {
        return Err("通常ファイル以外は扱えません".into());
    }
    Ok(())
}
pub fn directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(err)?;
    if !fs::symlink_metadata(path)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("保存領域のリンクを拒否しました".into());
    }
    Ok(())
}
pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("Invalid state path")?;
    directory(parent)?;
    if path.exists() {
        regular(path)?;
    }
    let temp = parent.join(format!(".state-{}", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(&temp).map_err(err)?;
    f.write_all(&serde_json::to_vec(value).map_err(err)?)
        .and_then(|_| f.sync_all())
        .map_err(err)?;
    fs::rename(&temp, path).map_err(err)?;
    sync_dir(parent)
}
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    regular(path)?;
    // Metadata is bounded. Media are streamed separately.
    if fs::metadata(path).map_err(err)?.len() > 64 * 1024 * 1024 {
        return Err("目録が大きすぎます".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)
}
pub fn gate(root: &Path, name: &str) -> Result<fs::File> {
    directory(root)?;
    let path = root.join(name);
    if path.exists() {
        regular(&path)?;
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(err)?;
    file.try_lock()
        .map_err(|_| "別のバックアップ・復元が実行中です".to_string())?;
    Ok(file)
}
pub fn series(root: &Path) -> Result<String> {
    let path = root.join("backup-series.json");
    if !path.exists() {
        atomic_json(&path, &uuid::Uuid::new_v4().to_string())?;
    }
    let id: String = read_json(&path)?;
    if !uuid(&id) {
        return Err("作品のバックアップIDが不正です".into());
    }
    Ok(id)
}
fn digest(path: &Path) -> Result<Entry> {
    regular(path)?;
    let mut file = fs::File::open(path).map_err(err)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    let mut size = 0;
    loop {
        let n = file.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        size += n as u64;
    }
    Ok(Entry {
        size,
        hash: format!("{:x}", hash.finalize()),
    })
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains(':'))
}
fn allowed(path: &str) -> bool {
    relative(path)
        && (path == "manga.sqlite3"
            || ["artifacts/", "media/", "blender/", "image-results/"]
                .iter()
                .any(|prefix| path.starts_with(prefix)))
}
fn inventory(root: &Path, dir: &Path, files: &mut BTreeMap<String, Entry>) -> Result<()> {
    if !fs::symlink_metadata(dir).map_err(err)?.file_type().is_dir() {
        return Err("フォルダのリンクを拒否しました".into());
    }
    for item in fs::read_dir(dir).map_err(err)? {
        let path = item.map_err(err)?.path();
        let meta = fs::symlink_metadata(&path).map_err(err)?;
        if meta.file_type().is_dir() {
            inventory(root, &path, files)?;
        } else if meta.file_type().is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(err)?
                .to_str()
                .ok_or("Invalid filename")?
                .to_string();
            if !allowed(&rel) {
                return Err("対象外ファイルを検出しました".into());
            }
            files.insert(rel, digest(&path)?);
        } else {
            return Err("リンク・特殊ファイルはバックアップできません".into());
        }
    }
    Ok(())
}
fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    if !fs::symlink_metadata(source)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("素材フォルダのリンクを拒否しました".into());
    }
    fs::create_dir(destination).map_err(err)?;
    for item in fs::read_dir(source).map_err(err)? {
        let item = item.map_err(err)?;
        let path = item.path();
        let name = item.file_name();
        // Unpublished partial files are never referenced by adopted state.
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let dest = destination.join(name);
        let meta = fs::symlink_metadata(&path).map_err(err)?;
        if meta.file_type().is_dir() {
            copy_tree(&path, &dest)?;
        } else {
            regular(&path)?;
            fs::copy(&path, &dest).map_err(err)?;
            fs::File::open(&dest)
                .and_then(|f| f.sync_all())
                .map_err(err)?;
            if digest(&path)? != digest(&dest)? {
                return Err("コピー中に素材が変更されました".into());
            }
        }
    }
    sync_dir(destination)
}
fn table(db: &Connection, name: &str) -> Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
    .map_err(err)
}
fn reject_secrets(value: &Value) -> Result<()> {
    match value {
        Value::Object(items) => {
            for (key, v) in items {
                if [
                    "api_key",
                    "apiKey",
                    "access_token",
                    "refresh_token",
                    "password",
                    "authorization",
                    "signed_url",
                ]
                .contains(&key.as_str())
                    && !v.is_null()
                    && v != ""
                {
                    return Err("作品内に認証情報があります。バックアップを停止しました".into());
                }
                reject_secrets(v)?;
            }
        }
        Value::Array(items) => {
            for v in items {
                reject_secrets(v)?;
            }
        }
        _ => (),
    }
    Ok(())
}

#[cfg(unix)]
pub fn require_space(path: &Path, bytes: u64) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(err)?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // statvfs writes the complete structure on success; path is a NUL-terminated owned string.
    if unsafe { libc::statvfs(cpath.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err("ディスク空き容量を確認できません".into());
    }
    let stat = unsafe { stat.assume_init() };
    let available = u128::from(stat.f_bavail) * u128::from(stat.f_frsize);
    if available < u128::from(bytes) + 16 * 1024 * 1024 {
        return Err("バックアップ・復元用の空き容量が不足しています".into());
    }
    Ok(())
}
#[cfg(not(unix))]
pub fn require_space(_: &Path, _: u64) -> Result<()> {
    Err("未対応の実行環境です".into())
}
fn manifest_size(m: &Manifest) -> Result<u64> {
    m.files.values().try_fold(0u64, |sum, e| {
        sum.checked_add(e.size)
            .ok_or("バックアップサイズが不正です".into())
    })
}
fn validate_project(project: &Value, root: &Path) -> Result<()> {
    if !matches!(project["version"].as_u64(), Some(1..=4)) {
        return Err("新しい作品形式です。対応版アプリが必要です".into());
    }
    reject_secrets(project)?;
    if let Some(captures) = project["captures"].as_array() {
        for capture in captures {
            let request = capture["request_id"]
                .as_str()
                .ok_or("撮影要求IDがありません")?;
            if !relative(request) || request.contains('/') {
                return Err("撮影要求IDが不正です".into());
            }
            let folder = root.join("blender").join(request);
            if digest(&folder.join("checkpoint.blend"))?.hash != capture["checkpoint"]["hash"]
                || digest(&folder.join("capture.png"))?.hash != capture["image"]["hash"]
            {
                return Err("過去の撮影版が欠損・変更されています".into());
            }
        }
    }
    let mut hydrated = project.clone();
    hydrate(&mut hydrated, &root.join("artifacts"))?;
    // Includes native job artifacts as well as adopted/candidate revisions.
    fn videos(value: &Value, root: &Path) -> Result<()> {
        match value {
            Value::Object(items) => {
                if value["mime"] == "video/mp4" && value.get("artifact_id").is_some() {
                    verify_video(root, value)?;
                }
                for v in items.values() {
                    videos(v, root)?;
                }
            }
            Value::Array(items) => {
                for v in items {
                    videos(v, root)?;
                }
            }
            _ => (),
        }
        Ok(())
    }
    videos(project, root)
}
fn validate_db(db: &Connection, root: &Path) -> Result<()> {
    if db
        .query_row::<String, _, _>("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(err)?
        != "ok"
    {
        return Err("作品DBの整合性検査に失敗しました".into());
    }
    validate_project(&super::raw_project(db)?, root)?;
    if table(db, "project_backups")? {
        let mut statement = db
            .prepare("SELECT data FROM project_backups")
            .map_err(err)?;
        for row in statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
        {
            validate_project(
                &serde_json::from_str(&row.map_err(err)?).map_err(err)?,
                root,
            )?;
        }
    }
    if table(db, "blender_sessions")? {
        let mut statement = db
            .prepare("SELECT data FROM blender_sessions")
            .map_err(err)?;
        for row in statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
        {
            let s: Value = serde_json::from_str(&row.map_err(err)?).map_err(err)?;
            let checkpoint = s["checkpoint"]
                .as_str()
                .ok_or("Blender保存版がありません")?;
            let path = root.join(checkpoint);
            if !relative(checkpoint)
                || !checkpoint.starts_with("blender/")
                || digest(&path)?.hash != s["hash"]
            {
                return Err("Blender保存版が不正です".into());
            }
            let result: Value = read_json(&path.with_file_name("result.json"))?;
            if result["dependencies_pinned"] != true
                || result["dependencies"] != json!([])
                || result["checkpoint"]["hash"] != s["hash"]
            {
                return Err(
                    "Blender依存素材が固定されていません。先に撮影・検査してください".into(),
                );
            }
            if let Some(image) = result.get("image").filter(|v| !v.is_null()) {
                if image["file"] != "capture.png"
                    || digest(&path.with_file_name("capture.png"))?.hash != image["hash"]
                {
                    return Err("撮影画像が欠損しています".into());
                }
            }
        }
    }
    Ok(())
}
// All native writers share AppState.db. Caller holds it only during staging,
// plus the existing engine/video gates while their files can be published.
pub fn prepare(db: &Connection, root: &Path, target: &Path, id: &str, at: u64) -> Result<Manifest> {
    if !uuid(id) {
        return Err("Invalid series".into());
    }
    if table(db, "blender_jobs")?
        && db
            .query_row::<bool, _, _>(
                "SELECT EXISTS(SELECT 1 FROM blender_jobs WHERE status='running')",
                [],
                |r| r.get(0),
            )
            .map_err(err)?
    {
        return Err("Blender処理中です。完了後にバックアップしてください".into());
    }
    fs::create_dir(target).map_err(err)?;
    let result = (|| {
        let mut copy = Connection::open(target.join("manga.sqlite3")).map_err(err)?;
        rusqlite::backup::Backup::new(db, &mut copy)
            .map_err(err)?
            .run_to_completion(128, std::time::Duration::from_millis(5), None)
            .map_err(err)?;
        copy.execute_batch("PRAGMA journal_mode=DELETE;")
            .map_err(err)?;
        // Portable checkpoint references; binary/library are machine settings and are not credentials or dependencies.
        if table(&copy, "blender_sessions")? {
            let rows: Vec<(String, String)> = copy
                .prepare("SELECT id,data FROM blender_sessions")
                .map_err(err)?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?
                .collect::<std::result::Result<_, _>>()
                .map_err(err)?;
            for (key, data) in rows {
                let mut s: Value = serde_json::from_str(&data).map_err(err)?;
                let source = Path::new(s["checkpoint"].as_str().ok_or("Missing checkpoint")?);
                let rel = source
                    .strip_prefix(root)
                    .map_err(|_| "Blender素材を先に検査・撮影し、依存素材を固定してください")?
                    .to_str()
                    .ok_or("Invalid path")?;
                if !rel.starts_with("blender/") || !relative(rel) {
                    return Err("未固定のBlender保存版です".into());
                }
                s["checkpoint"] = json!(rel);
                s["library"] = json!("");
                s["binary"] = json!("");
                copy.execute(
                    "UPDATE blender_sessions SET data=?1 WHERE id=?2",
                    rusqlite::params![s.to_string(), key],
                )
                .map_err(err)?;
            }
        }
        for name in ["artifacts", "media", "blender", "image-results"] {
            let source = root.join(name);
            if source.exists() {
                copy_tree(&source, &target.join(name))?;
            }
        }
        validate_db(&copy, target)?;
        let schema = super::raw_project(&copy)?["version"]
            .as_u64()
            .ok_or("Missing schema")?;
        drop(copy);
        let mut files = BTreeMap::new();
        inventory(target, target, &mut files)?;
        let manifest = Manifest {
            format: FORMAT,
            app_version: env!("CARGO_PKG_VERSION").into(),
            project_schema: schema,
            series: id.into(),
            created_at: at,
            files,
            excluded: vec![
                "AI model weights and temporary files".into(),
                "credentials and cloud configuration".into(),
                "unmanaged external exports and unsaved Blender edits".into(),
            ],
        };
        atomic_json(&target.join("manifest.json"), &manifest)?;
        verify_bundle(target)?;
        Ok(manifest)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(target);
    }
    result
}
pub fn verify_bundle(root: &Path) -> Result<Manifest> {
    let m: Manifest = read_json(&root.join("manifest.json"))?;
    if m.format != FORMAT
        || !uuid(&m.series)
        || !(1..=4).contains(&m.project_schema)
        || !m.files.contains_key("manga.sqlite3")
    {
        return Err("未対応のバックアップ形式です。対応版アプリが必要です".into());
    }
    for (path, expected) in &m.files {
        if !allowed(path) || !valid_hash(&expected.hash) {
            return Err("目録のパス・hashが不正です".into());
        }
        let mut current = root.to_path_buf();
        let parts: Vec<_> = path.split('/').collect();
        for (i, part) in parts.iter().enumerate() {
            current.push(part);
            let meta = fs::symlink_metadata(&current).map_err(err)?;
            if i + 1 < parts.len() && !meta.file_type().is_dir() {
                return Err("フォルダのリンクを拒否しました".into());
            }
        }
        if digest(&current)? != *expected {
            return Err("バックアップのサイズ・hashが一致しません".into());
        }
    }
    // Reject unlisted payloads, including executable files/symlinks supplied by a foreign snapshot.
    fn names(root: &Path, dir: &Path, out: &mut BTreeSet<String>) -> Result<()> {
        if !fs::symlink_metadata(dir).map_err(err)?.file_type().is_dir() {
            return Err("Invalid directory".into());
        }
        for item in fs::read_dir(dir).map_err(err)? {
            let p = item.map_err(err)?.path();
            if fs::symlink_metadata(&p).map_err(err)?.file_type().is_dir() {
                names(root, &p, out)?;
            } else {
                regular(&p)?;
                out.insert(
                    p.strip_prefix(root)
                        .map_err(err)?
                        .to_str()
                        .ok_or("Invalid path")?
                        .into(),
                );
            }
        }
        Ok(())
    }
    let mut actual = BTreeSet::new();
    names(root, root, &mut actual)?;
    actual.remove("manifest.json");
    if actual != m.files.keys().cloned().collect() {
        return Err("目録にないファイルがあります".into());
    }
    let db = Connection::open_with_flags(
        root.join("manga.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(err)?;
    validate_db(&db, root)?;
    if super::raw_project(&db)?["version"].as_u64() != Some(m.project_schema) {
        return Err("目録と作品形式が一致しません".into());
    }
    Ok(m)
}
pub fn restore(bundle: &Path, base: &Path) -> Result<String> {
    let manifest = verify_bundle(bundle)?;
    require_space(base, manifest_size(&manifest)?)?;
    let parent = base.join("restored");
    directory(&parent)?;
    let id = uuid::Uuid::new_v4().to_string();
    let target = parent.join(&id);
    copy_tree(bundle, &target)?;
    let result = (|| {
        verify_bundle(&target)?;
        let db = Connection::open(target.join("manga.sqlite3")).map_err(err)?;
        if table(&db, "blender_sessions")? {
            let rows: Vec<(String, String)> = db
                .prepare("SELECT id,data FROM blender_sessions")
                .map_err(err)?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?
                .collect::<std::result::Result<_, _>>()
                .map_err(err)?;
            for (key, data) in rows {
                let mut s: Value = serde_json::from_str(&data).map_err(err)?;
                s["checkpoint"] =
                    json!(target.join(s["checkpoint"].as_str().ok_or("Missing checkpoint")?));
                s["library"] = json!(&target);
                db.execute(
                    "UPDATE blender_sessions SET data=?1 WHERE id=?2",
                    rusqlite::params![s.to_string(), key],
                )
                .map_err(err)?;
            }
        }
        // Import is an independent workspace; never resubmit external jobs here.
        atomic_json(&target.join("backup-series.json"), &id)?;
        atomic_json(
            &target.join("restored-from.json"),
            &json!({"series":manifest.series,"created_at":manifest.created_at,"restored_at":now()?}),
        )?;
        fs::remove_file(target.join("manifest.json")).map_err(err)?;
        sync_dir(&target)?;
        Ok(id)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&target);
    }
    result
}
/// Tracks native job and Blender changes as well as UI revisions.
pub fn fingerprint(db: &Connection) -> Result<String> {
    let mut bytes = Vec::new();
    for (name, query) in [("project", "SELECT data FROM project ORDER BY id"), ("blender_sessions", "SELECT data FROM blender_sessions ORDER BY id"), ("blender_jobs", "SELECT json_array(id,session_id,status,expected_revision,result) FROM blender_jobs ORDER BY id")] {
        if table(db,name)? { let mut stmt=db.prepare(query).map_err(err)?; for row in stmt.query_map([],|r|r.get::<_,String>(0)).map_err(err)? {bytes.extend_from_slice(row.map_err(err)?.as_bytes()); bytes.push(0);} }
    }
    Ok(hash(&bytes))
}
pub fn recover_work(base: &Path, root: &Path) -> Result<()> {
    let _gate = gate(base, ".backup-operation.lock")?;
    let work = base.join("backup-work");
    if work.exists() {
        for entry in fs::read_dir(&work).map_err(err)? {
            let entry = entry.map_err(err)?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.strip_prefix("work-").is_some_and(uuid)
                && entry.file_type().map_err(err)?.is_dir()
            {
                fs::remove_dir_all(entry.path()).map_err(err)?;
            }
        }
    }
    let mut status = restic::status(root)?;
    if ["preparing", "uploading", "verifying"].contains(&status.phase.as_str()) {
        status.phase = "failed".into();
        status.failure = "前回のバックアップは中断しました。旧正常版を保持し、再検証します".into();
        status.next_attempt = now()? + 3600;
        restic::save_status(root, &status)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wal_roundtrip_history_isolated_restore_and_corruption() {
        let (mut db, root) = super::super::tests::setup();
        let project = super::super::tests::fixture();
        super::super::save(&mut db, &root, &project.to_string()).unwrap();
        let outside = root.with_extension("backup");
        let id = series(&root).unwrap();
        prepare(&db, &root, &outside, &id, 100).unwrap();
        let restored = restore(&outside, &root).unwrap();
        assert_ne!(restored, id);
        let dest = root.join("restored").join(restored);
        let copy = Connection::open(dest.join("manga.sqlite3")).unwrap();
        assert_eq!(
            super::super::load(&copy, &dest).unwrap(),
            super::super::load(&db, &root).unwrap()
        );
        fs::write(outside.join("manga.sqlite3"), b"bad").unwrap();
        assert!(restore(&outside, &root).is_err());
        assert_eq!(
            super::super::raw_project(&db).unwrap()["version"],
            project["version"]
        );
        fs::remove_dir_all(outside).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn video_blender_history_and_source_contract_survive_another_root() {
        let (mut db, root) = super::super::tests::setup();
        let mut project = super::super::tests::fixture();
        project["version"] = json!(4);
        project["source_contract"] = json!({"verified_structure_commit":"structure-commit","manuscript_commit":"different-content-commit"});
        let video = STANDARD
            .decode(include_str!("../../tests/fixtures/video-blue.mp4.base64").trim())
            .unwrap();
        let artifact = super::super::put_video(&root, video.as_slice(), None).unwrap();
        project["videoRevisions"] = json!([{"id":"video","artifact":artifact}]);
        let folder = root.join("blender/fixture");
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("checkpoint.blend"),
            b"synthetic packed blend fixture, not a render",
        )
        .unwrap();
        let blend = digest(&folder.join("checkpoint.blend")).unwrap().hash;
        let result = json!({"protocol":1,"blender_version":[4,5,13],"dependencies_pinned":true,"dependencies":[],"checkpoint":{"file":"checkpoint.blend","hash":blend},"image":null});
        atomic_json(&folder.join("result.json"), &result).unwrap();
        db.execute_batch("CREATE TABLE blender_sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL)")
            .unwrap();
        db.execute("INSERT INTO blender_sessions VALUES('session',?1)",[json!({"checkpoint":folder.join("checkpoint.blend"),"hash":blend,"binary":"/old/Blender","library":"/old/library","state":result}).to_string()]).unwrap();
        super::super::save(&mut db, &root, &project.to_string()).unwrap();
        let bundle = root.with_extension("bundle");
        prepare(&db, &root, &bundle, &series(&root).unwrap(), 100).unwrap();
        let id = restore(&bundle, &root).unwrap();
        let target = root.join("restored").join(id);
        let restored_db = Connection::open(target.join("manga.sqlite3")).unwrap();
        let restored: Value =
            serde_json::from_str(&super::super::load(&restored_db, &target).unwrap().unwrap())
                .unwrap();
        assert_eq!(project, restored);
        let data: String = restored_db
            .query_row("SELECT data FROM blender_sessions", [], |r| r.get(0))
            .unwrap();
        let session: Value = serde_json::from_str(&data).unwrap();
        assert_eq!(
            session["checkpoint"],
            json!(target.join("blender/fixture/checkpoint.blend"))
        );
        assert_eq!(session["binary"], "");
        super::super::verify_video(&target, &artifact).unwrap();
        fs::write(
            root.join("media")
                .join(format!("{}.mp4", artifact["hash"].as_str().unwrap())),
            b"corrupt",
        )
        .unwrap();
        let bad = root.with_extension("bad-bundle");
        assert!(prepare(&db, &root, &bad, &series(&root).unwrap(), 101).is_err());
        assert!(!bad.exists());
        fs::remove_dir_all(bundle).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_links_secrets_and_missing_history_media() {
        let (mut db, root) = super::super::tests::setup();
        let mut p = super::super::tests::fixture();
        super::super::save(&mut db, &root, &p.to_string()).unwrap();
        let target = root.with_extension("backup");
        let id = series(&root).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("artifacts/foreign")).unwrap();
        assert!(prepare(&db, &root, &target, &id, 100).is_err());
        assert!(!target.exists());
        fs::remove_file(root.join("artifacts/foreign")).unwrap();
        p["api_key"] = json!("secret-canary");
        super::super::save(&mut db, &root, &p.to_string()).unwrap();
        assert!(prepare(&db, &root, &target, &id, 100).is_err());
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
