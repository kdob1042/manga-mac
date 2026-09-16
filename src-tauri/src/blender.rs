//! A dedicated, one-shot Blender CLI session. bpy owns scene/camera/render state.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tokio::io::AsyncWriteExt;
const WORKER: &str = include_str!("../../blender/worker.py");
fn error() -> String {
    "Blender処理を完了できませんでした。要求状態を確認してください".into()
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
fn canonical(path: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|_| "指定パスを開けません".into())
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub binary: String,
    pub library_root: String,
    pub source: String,
}
#[derive(Deserialize, Serialize, Clone)]
struct Session {
    id: String,
    binary: PathBuf,
    library: PathBuf,
    checkpoint: PathBuf,
    hash: String,
    revision: u64,
    state: Value,
    #[serde(default)]
    parent_session_id: Option<String>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Operation {
    Inspect,
    Catalog,
    Pose {
        rig: String,
        action: String,
        frame: i32,
    },
    Import {
        file: String,
        hash: String,
        asset_type: String,
        name: String,
    },
    Camera {
        lens: f64,
    },
    Capture {
        width: u32,
        height: u32,
    },
    Shot {
        scene: String,
        camera: String,
        frame: i32,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub session_id: String,
    pub request_id: String,
    pub expected_revision: u64,
    pub operation: Operation,
}
pub fn initialize(db: &rusqlite::Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS blender_sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blender_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,expected_revision INTEGER NOT NULL,result TEXT); UPDATE blender_jobs SET status='unknown' WHERE status='running';").map_err(|_|error())
}
pub fn register(db: &rusqlite::Connection, input: Registration) -> Result<Value, String> {
    let binary = canonical(&input.binary)?;
    let library = canonical(&input.library_root)?;
    let source = canonical(&input.source)?;
    if !binary.is_file()
        || !library.is_dir()
        || !source.is_file()
        || !source.starts_with(&library)
        || source.extension().and_then(|s| s.to_str()) != Some("blend")
    {
        return Err(
            "Blender実行ファイル・認可素材フォルダ・その中のblendを指定してください".into(),
        );
    }
    let id = format!(
        "session-{:x}",
        Sha256::digest(
            format!("{}:{:?}", source.display(), std::time::SystemTime::now()).as_bytes()
        )
    );
    let session = Session {
        id: id.clone(),
        binary,
        library,
        hash: hash(&source)?,
        checkpoint: source,
        revision: 0,
        state: Value::Null,
        parent_session_id: None,
    };
    db.execute(
        "INSERT INTO blender_sessions(id,data) VALUES(?1,?2)",
        rusqlite::params![id, serde_json::to_string(&session).map_err(|_| error())?],
    )
    .map_err(|_| error())?;
    Ok(json!({"session_id":id,"revision":0,"state":null,"verified":false}))
}
fn session(db: &rusqlite::Connection, id: &str) -> Result<Session, String> {
    let data: String = db
        .query_row("SELECT data FROM blender_sessions WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "Blender接続を登録してください")?;
    serde_json::from_str(&data).map_err(|_| error())
}
pub fn status(db: &rusqlite::Connection, id: &str) -> Result<Value, String> {
    let session = session(db, id)?;
    let mut statement=db.prepare("SELECT id,status,expected_revision FROM blender_jobs WHERE session_id=?1 ORDER BY CASE WHEN status IN ('unknown','running','candidate') THEN 0 ELSE 1 END, rowid DESC LIMIT 20").map_err(|_|error())?;
    let jobs:Vec<Value>=statement.query_map([id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"expected_revision":r.get::<_,u64>(2)?}))).map_err(|_|error())?.collect::<Result<_,_>>().map_err(|_|error())?;
    let mut response = json!({"session_id":session.id,"revision":session.revision,"state":session.state,"jobs":jobs});
    if !response["state"]["image"].is_null() {
        let folder = session.checkpoint.parent().ok_or_else(error)?;
        let verified = verify_output(folder)?;
        if verified != response["state"] || verified["checkpoint"]["hash"] != session.hash {
            return Err("採用済みBlender成果物が変更されています".into());
        }
        response["preview"] = Value::String(preview(folder)?);
    }
    Ok(response)
}
/// Rebind only the executable on a restored workspace; checkpoints and IDs stay fixed.
pub fn rebind_restored(
    db: &mut rusqlite::Connection,
    root: &Path,
    binary: &str,
) -> Result<(), String> {
    if !root.join("restored-from.json").is_file() {
        return Err("復元作品だけの操作です".into());
    }
    let binary = canonical(binary)?;
    if !binary.is_file() {
        return Err("Blender実行ファイルを指定してください".into());
    }
    let tx = db.transaction().map_err(|_| error())?;
    let pending: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM blender_jobs WHERE status='running')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| error())?;
    if pending {
        return Err("Blender処理終了後に再接続してください".into());
    }
    let rows: Vec<(String, String)> = tx
        .prepare("SELECT id,data FROM blender_sessions")
        .map_err(|_| error())?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|_| error())?
        .collect::<Result<_, _>>()
        .map_err(|_| error())?;
    for (id, data) in rows {
        let mut s: Session = serde_json::from_str(&data).map_err(|_| error())?;
        if !s.checkpoint.starts_with(root) || hash(&s.checkpoint)? != s.hash {
            return Err("復元した保存版が変わっています".into());
        }
        s.binary = binary.clone();
        s.library = root.to_path_buf();
        tx.execute(
            "UPDATE blender_sessions SET data=?1 WHERE id=?2",
            rusqlite::params![serde_json::to_string(&s).map_err(|_| error())?, id],
        )
        .map_err(|_| error())?;
    }
    tx.commit().map_err(|_| error())
}
pub fn latest(db: &rusqlite::Connection) -> Result<Option<Value>, String> {
    use rusqlite::OptionalExtension;
    let id: Option<String> = db.query_row("SELECT id FROM blender_sessions WHERE json_extract(data,'$.parent_session_id') IS NULL ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0)).optional().map_err(|_|error())?;
    id.map(|id| status(db, &id)).transpose()
}
/// Fork immutable checkpoints by reference. Each child is later opened in a separate
/// Blender process and written to a fresh job folder; no shared Object/Action is mutated.
pub fn fork_shots(
    db: &mut rusqlite::Connection,
    id: &str,
    expected_revision: u64,
    ids: Vec<String>,
) -> Result<Vec<Value>, String> {
    if ids.is_empty()
        || ids.len() > 4
        || ids.iter().any(|id| !valid_id(id))
        || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
    {
        return Err("1〜4件の重複しないショットIDが必要です".into());
    }
    let tx = db.transaction().map_err(|_| error())?;
    let base = session(&tx, id)?;
    if base.revision != expected_revision || base.state["dependencies_pinned"] != true {
        return Err("版固定済みのBlender接続を再確認してください".into());
    }
    let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM blender_jobs WHERE session_id=?1 AND status IN ('running','unknown','candidate'))", [id], |r| r.get(0)).map_err(|_| error())?;
    if pending {
        return Err("先に未確定の要求を解決してください".into());
    }
    let folder = base.checkpoint.parent().ok_or_else(error)?;
    let verified = verify_output(folder)?;
    if verified != base.state || verified["checkpoint"]["hash"] != base.hash {
        return Err(error());
    }
    let mut output = Vec::new();
    for id in ids {
        let mut shot = base.clone();
        shot.parent_session_id = Some(base.id.clone());
        shot.id = id.clone();
        shot.revision = 0;
        tx.execute(
            "INSERT INTO blender_sessions(id,data) VALUES(?1,?2)",
            rusqlite::params![id, serde_json::to_string(&shot).map_err(|_| error())?],
        )
        .map_err(|_| "このショットIDは使用済みです")?;
        output.push(json!({"session_id":id,"revision":0,"state":shot.state}));
    }
    tx.commit().map_err(|_| error())?;
    Ok(output)
}

/// Read an immutable, completed capture even after its working session advances.
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

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryAction {
    Adopt,
    Abandon,
}

pub fn recover(
    db: &mut rusqlite::Connection,
    root: &Path,
    session_id: &str,
    request_id: &str,
    expected_revision: u64,
    action: RecoveryAction,
) -> Result<Value, String> {
    if !valid_id(request_id) {
        return Err("要求IDが不正です".into());
    }
    let tx = db.transaction().map_err(|_| error())?;
    let mut current = session(&tx, session_id)?;
    if current.revision != expected_revision {
        return Err("Blenderの版が更新されています。状態を再確認してください".into());
    }
    let (job_status, base): (String, u64) = tx
        .query_row(
            "SELECT status,expected_revision FROM blender_jobs WHERE id=?1 AND session_id=?2",
            rusqlite::params![request_id, session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| error())?;
    if !matches!(job_status.as_str(), "unknown" | "candidate") {
        return Err("この要求は復旧対象ではありません".into());
    }
    match action {
        RecoveryAction::Abandon => {
            // Resolve the local job only. Do not delete output or claim a remote process was cancelled.
            tx.execute(
                "UPDATE blender_jobs SET status='abandoned' WHERE id=?1",
                [request_id],
            )
            .map_err(|_| error())?;
        }
        RecoveryAction::Adopt => {
            if base != current.revision {
                return Err("旧版の成果物は現在の接続版へ採用できません".into());
            }
            let folder = root.join("blender").join(request_id);
            let metadata = std::fs::symlink_metadata(&folder).map_err(|_| error())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(error());
            }
            let result = verify_output(&folder)?;
            sync_output(&folder)?;
            current.checkpoint = folder.join("checkpoint.blend");
            current.hash = result["checkpoint"]["hash"]
                .as_str()
                .ok_or_else(error)?
                .into();
            current.revision += 1;
            current.state = result.clone();
            tx.execute(
                "UPDATE blender_sessions SET data=?2 WHERE id=?1",
                rusqlite::params![
                    session_id,
                    serde_json::to_string(&current).map_err(|_| error())?
                ],
            )
            .map_err(|_| error())?;
            tx.execute(
                "UPDATE blender_jobs SET status='complete',result=?2 WHERE id=?1",
                rusqlite::params![request_id, result.to_string()],
            )
            .map_err(|_| error())?;
        }
    }
    tx.commit().map_err(|_| error())?;
    status(db, session_id)
}

fn sync_output(folder: &Path) -> Result<(), String> {
    for name in ["checkpoint.blend", "result.json", "capture.png"] {
        let path = folder.join(name);
        if path.exists() {
            std::fs::File::open(path)
                .map_err(|_| error())?
                .sync_all()
                .map_err(|_| error())?;
        }
    }
    std::fs::File::open(folder)
        .map_err(|_| error())?
        .sync_all()
        .map_err(|_| error())?;
    Ok(())
}

pub async fn execute(
    db: &Mutex<rusqlite::Connection>,
    root: &Path,
    request: Request,
) -> Result<Value, String> {
    if !valid_id(&request.request_id) {
        return Err("要求IDが不正です".into());
    }
    match &request.operation {
        Operation::Camera { lens } if !lens.is_finite() || !(10.0..=250.0).contains(lens) => {
            return Err("焦点距離は10〜250mmです".into())
        }
        Operation::Capture { width, height }
            if !(64..=4096).contains(width) || !(64..=4096).contains(height) =>
        {
            return Err("撮影寸法は64〜4096です".into())
        }
        Operation::Import {
            file,
            hash,
            asset_type,
            name,
        } if file.len() > 4096
            || file.is_empty()
            || hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
            || !matches!(asset_type.as_str(), "OBJECT" | "COLLECTION" | "ACTION")
            || name.is_empty()
            || name.len() > 256 =>
        {
            return Err("素材参照が不正です".into())
        }
        Operation::Pose { rig, action, frame }
            if rig.is_empty()
                || rig.len() > 256
                || action.is_empty()
                || action.len() > 256
                || !(-1048574..=1048574).contains(frame) =>
        {
            return Err("リグ・ポーズ・frameが不正です".into())
        }
        Operation::Shot {
            scene,
            camera,
            frame,
        } if scene.is_empty()
            || camera.is_empty()
            || scene.len() > 256
            || camera.len() > 256
            || !(-1048574..=1048574).contains(frame) =>
        {
            return Err("Scene・Camera・frameが不正です".into())
        }
        _ => {}
    }
    let mut current = {
        let db = db.lock().map_err(|_| error())?;
        let current = session(&db, &request.session_id)?;
        if current.revision != request.expected_revision {
            return Err("Blenderの版が更新されています。状態を再確認してください".into());
        }
        let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM blender_jobs WHERE session_id=?1 AND status IN ('running','unknown','candidate'))",[&request.session_id],|r|r.get(0)).map_err(|_|error())?;
        if pending {
            return Err("応答未確定のBlender要求があります。状態確認が必要です".into());
        }
        db.execute("INSERT INTO blender_jobs(id,session_id,status,expected_revision) VALUES(?1,?2,'running',?3)",rusqlite::params![request.request_id,request.session_id,request.expected_revision]).map_err(|_|"送信済みの要求です。自動再実行しません")?;
        current
    };
    let folder = root.join("blender").join(&request.request_id);
    let result = run(&current, &folder, &request.operation).await;
    let mut db = db.lock().map_err(|_| error())?;
    match result {
        Ok(result) => {
            if session(&db, &current.id)?.revision != request.expected_revision {
                db.execute(
                    "UPDATE blender_jobs SET status='candidate',result=?2 WHERE id=?1",
                    rusqlite::params![request.request_id, result.to_string()],
                )
                .map_err(|_| error())?;
                return Err("旧版の撮影結果を候補として保持しました".into());
            }
            current.checkpoint = folder.join("checkpoint.blend");
            current.hash = result["checkpoint"]["hash"]
                .as_str()
                .ok_or_else(error)?
                .into();
            current.revision += 1;
            current.state = result.clone();
            let tx = db.transaction().map_err(|_| error())?;
            tx.execute(
                "UPDATE blender_sessions SET data=?2 WHERE id=?1",
                rusqlite::params![
                    current.id,
                    serde_json::to_string(&current).map_err(|_| error())?
                ],
            )
            .map_err(|_| error())?;
            tx.execute(
                "UPDATE blender_jobs SET status='complete',result=?2 WHERE id=?1",
                rusqlite::params![request.request_id, result.to_string()],
            )
            .map_err(|_| error())?;
            tx.commit().map_err(|_| error())?;
            let mut response = json!({"session_id":current.id,"revision":current.revision,"request_id":request.request_id,"state":result});
            if !response["state"]["image"].is_null() {
                response["preview"] = Value::String(preview(&folder)?);
            }
            Ok(response)
        }
        Err(e) => {
            db.execute(
                "UPDATE blender_jobs SET status='unknown' WHERE id=?1",
                [request.request_id],
            )
            .map_err(|_| error())?;
            Err(e)
        }
    }
}
async fn run(session: &Session, folder: &Path, operation: &Operation) -> Result<Value, String> {
    if hash(&session.checkpoint)? != session.hash {
        return Err("Blenderの入力版が変更されています".into());
    }
    std::fs::create_dir_all(folder.parent().ok_or_else(error)?).map_err(|_| error())?;
    std::fs::create_dir(folder).map_err(|_| error())?;
    // The executable script is fixed application content, never text from a model or job.
    let script = folder.with_extension("py");
    std::fs::write(&script, WORKER).map_err(|_| error())?;
    let input = json!({"input":session.checkpoint,"input_hash":session.hash,"library_root":session.library,"output_root":folder,"operation":operation});
    let mut command = tokio::process::Command::new(&session.binary);
    command.env_clear();
    for name in ["HOME", "TMPDIR", "PATH", "LANG", "DISPLAY", "XAUTHORITY"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .args([
            "--background",
            "--factory-startup",
            "--disable-autoexec",
            "--python-exit-code",
            "1",
            "--python",
        ])
        .arg(&script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| error())?;
    let mut stdin = child.stdin.take().ok_or_else(error)?;
    stdin
        .write_all(input.to_string().as_bytes())
        .await
        .map_err(|_| error())?;
    drop(stdin);
    let status = tokio::time::timeout(Duration::from_secs(600), child.wait())
        .await
        .map_err(|_| error())?
        .map_err(|_| error())?;
    if !status.success() {
        return Err(error());
    }
    let result = verify_output(folder)?;
    sync_output(folder)?;
    Ok(result)
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        db: rusqlite::Connection,
        id: String,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn fixture() -> Fixture {
        let id = "00000000-0000-4000-8000-000000000099".to_string();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Clock resolution can be coarser than simultaneous test starts on macOS.
        // Reserve exclusively; a stale directory is never reused or removed.
        let root = loop {
            let sequence = NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "manga-recovery-{}-{stamp}-{sequence}",
                std::process::id()
            ));
            match std::fs::create_dir(&path) {
                Ok(()) => break path,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("Cannot reserve test directory: {error}"),
            }
        };
        let db = rusqlite::Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        let source = root.join("original.blend");
        std::fs::write(
            &source,
            b"synthetic checkpoint for file integrity tests only",
        )
        .unwrap();
        let session = Session {
            id: "test-session".into(),
            binary: PathBuf::new(),
            library: root.clone(),
            checkpoint: source.clone(),
            hash: hash(&source).unwrap(),
            revision: 0,
            state: Value::Null,
            parent_session_id: None,
        };
        db.execute(
            "INSERT INTO blender_sessions(id,data) VALUES(?1,?2)",
            rusqlite::params![session.id, serde_json::to_string(&session).unwrap()],
        )
        .unwrap();
        db.execute("INSERT INTO blender_jobs(id,session_id,status,expected_revision) VALUES(?1,'test-session','running',0)", [&id]).unwrap();
        let folder = root.join("blender").join(&id);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("checkpoint.blend"),
            b"synthetic completed checkpoint",
        )
        .unwrap();
        let result = json!({"protocol":1,"blender_version":[4,5,13],
            "checkpoint":{"file":"checkpoint.blend","hash":hash(&folder.join("checkpoint.blend")).unwrap()},
            "image":null,"state":{"lens":70}});
        std::fs::write(folder.join("result.json"), result.to_string()).unwrap();
        Fixture { root, db, id }
    }

    #[test]
    fn interrupted_output_is_adopted_once_without_starting_blender() {
        let mut f = fixture();
        assert!(recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            0,
            RecoveryAction::Adopt
        )
        .is_err());
        initialize(&f.db).unwrap(); // A restart makes the running request unknown.
        let restored = recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            0,
            RecoveryAction::Adopt,
        )
        .unwrap();
        assert_eq!(restored["revision"], 1);
        assert_eq!(restored["jobs"][0]["status"], "complete");
        assert!(recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            1,
            RecoveryAction::Adopt
        )
        .is_err());
        assert!(f.root.join("original.blend").exists());
    }

    #[test]
    fn corrupt_or_stale_results_preserve_current_revision_and_can_be_abandoned() {
        let mut f = fixture();
        initialize(&f.db).unwrap();
        assert!(recover(
            &mut f.db,
            &f.root,
            "other-session",
            &f.id,
            0,
            RecoveryAction::Adopt
        )
        .is_err());
        assert!(recover(
            &mut f.db,
            &f.root,
            "test-session",
            "../escape",
            0,
            RecoveryAction::Adopt
        )
        .is_err());
        assert!(recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            1,
            RecoveryAction::Adopt
        )
        .is_err());
        let output = f.root.join("blender").join(&f.id).join("checkpoint.blend");
        std::fs::write(&output, b"corrupt").unwrap();
        assert!(recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            0,
            RecoveryAction::Adopt
        )
        .is_err());
        assert_eq!(status(&f.db, "test-session").unwrap()["revision"], 0);
        let resolved = recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            0,
            RecoveryAction::Abandon,
        )
        .unwrap();
        assert_eq!(resolved["revision"], 0);
        assert_eq!(resolved["jobs"][0]["status"], "abandoned");
        assert!(output.exists());
    }

    #[test]
    fn output_from_an_old_base_cannot_replace_newer_state() {
        let mut f = fixture();
        initialize(&f.db).unwrap();
        let mut newer = session(&f.db, "test-session").unwrap();
        newer.revision = 1;
        f.db.execute(
            "UPDATE blender_sessions SET data=?1 WHERE id='test-session'",
            [serde_json::to_string(&newer).unwrap()],
        )
        .unwrap();
        assert!(recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            1,
            RecoveryAction::Adopt
        )
        .is_err());
        assert_eq!(status(&f.db, "test-session").unwrap()["revision"], 1);
    }
    #[test]
    fn restored_preview_is_read_from_verified_output_and_tampering_is_rejected() {
        let mut f = fixture();
        initialize(&f.db).unwrap();
        let folder = f.root.join("blender").join(&f.id);
        // Signature-only synthetic data checks the transport contract, not PNG decoding.
        std::fs::write(folder.join("capture.png"), b"\x89PNG\r\n\x1a\nsynthetic").unwrap();
        let mut result = verify_output(&folder).unwrap();
        result["image"] =
            json!({"file":"capture.png","hash":hash(&folder.join("capture.png")).unwrap()});
        std::fs::write(folder.join("result.json"), result.to_string()).unwrap();
        let adopted = recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            0,
            RecoveryAction::Adopt,
        )
        .unwrap();
        let reopened = status(&f.db, "test-session").unwrap();
        assert_eq!(adopted["preview"], reopened["preview"]);
        assert!(reopened["preview"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        std::fs::write(folder.join("capture.png"), b"changed").unwrap();
        assert!(status(&f.db, "test-session").is_err());
        assert_eq!(session(&f.db, "test-session").unwrap().revision, 1);
    }

    #[test]
    fn four_shots_share_only_an_immutable_checkpoint_and_duplicate_ids_are_atomic() {
        let mut f = fixture();
        initialize(&f.db).unwrap();
        let folder = f.root.join("blender").join(&f.id);
        let mut result = verify_output(&folder).unwrap();
        result["dependencies_pinned"] = json!(true);
        std::fs::write(folder.join("result.json"), result.to_string()).unwrap();
        recover(
            &mut f.db,
            &f.root,
            "test-session",
            &f.id,
            0,
            RecoveryAction::Adopt,
        )
        .unwrap();
        let ids: Vec<String> = (1..=4)
            .map(|n| format!("00000000-0000-4000-8000-{n:012}"))
            .collect();
        let shots = fork_shots(&mut f.db, "test-session", 1, ids.clone()).unwrap();
        assert_eq!(shots.len(), 4);
        for id in &ids {
            let shot = session(&f.db, id).unwrap();
            assert_eq!(shot.checkpoint, folder.join("checkpoint.blend"));
            assert_eq!(shot.revision, 0);
            assert_eq!(shot.parent_session_id.as_deref(), Some("test-session"));
        }
        assert_eq!(
            latest(&f.db).unwrap().unwrap()["session_id"],
            "test-session"
        );
        let fresh = "00000000-0000-4000-8000-000000000005".to_string();
        assert!(fork_shots(
            &mut f.db,
            "test-session",
            1,
            vec![fresh.clone(), ids[0].clone()]
        )
        .is_err());
        assert!(session(&f.db, &fresh).is_err()); // transaction rolled back the first insertion
        std::fs::write(folder.join("checkpoint.blend"), b"tampered").unwrap();
        assert!(fork_shots(&mut f.db, "test-session", 1, vec![fresh]).is_err());
    }
}
