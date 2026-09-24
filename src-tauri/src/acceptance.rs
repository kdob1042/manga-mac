//! Opt-in, isolated Mac acceptance diagnostics. Never opens normal user storage.
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const SCHEMA: &str = "manga-mac/acceptance/v1";
pub const FIXTURE: &str = "manga-mac/acceptance-fixture/v1";
const REGISTRY: &str = include_str!("../../src/media-registry.json");
const STAGES: &[&str] = &[
    "fixture_save",
    "fixture_reload",
    "renderer",
    "export_png",
    "generation",
    "adoption",
    "restart",
    "visual_review",
    "p01_review",
    "name_v2_compiler",
];
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
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[derive(Debug, PartialEq)]
pub enum Mode {
    Normal,
    Preflight,
    Session(String),
}
pub fn parse_args(args: &[String]) -> Result<Mode> {
    let special = args.iter().any(|arg| arg.starts_with("--acceptance"));
    if !special {
        return Ok(Mode::Normal);
    }
    match args {
        [flag] if flag == "--acceptance-preflight" => Ok(Mode::Preflight),
        [flag, id] if flag == "--acceptance-session" && valid_id(id) => Ok(Mode::Session(id.to_ascii_lowercase())),
        _ => Err("Use --acceptance-preflight or --acceptance-session UUID; normal storage was not opened".into()),
    }
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id)
        .is_ok_and(|parsed| parsed.hyphenated().to_string() == id.to_ascii_lowercase())
}
fn system_value(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() || out.stdout.len() > 1024 {
        return None;
    }
    Some(String::from_utf8(out.stdout).ok()?.trim().to_owned())
}
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // statvfs field widths differ between macOS and Linux.
fn free_disk_bytes() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // Constant root path: no user paths or identifiers enter the report.
    if unsafe { libc::statvfs(c"/".as_ptr(), info.as_mut_ptr()) } != 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    (info.f_bavail as u64).checked_mul(info.f_frsize as u64)
}
#[cfg(not(unix))]
fn free_disk_bytes() -> Option<u64> {
    None
}
fn file_hash(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(err)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
fn executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
fn runtime_kind(executable: Option<&Path>) -> &'static str {
    let bundled = executable.and_then(Path::parent).is_some_and(|macos| {
        macos.file_name().is_some_and(|name| name == "MacOS")
            && macos.parent().is_some_and(|contents| {
                contents.file_name().is_some_and(|name| name == "Contents")
                    && contents
                        .parent()
                        .and_then(Path::extension)
                        .is_some_and(|ext| ext == "app")
            })
    });
    if bundled {
        "app-bundle"
    } else {
        "standalone-binary"
    }
}
/// Reads only platform facts and the bundled helper. Never launches helper/LLM or fetches models.
pub fn preflight(helper: Option<&Path>) -> Value {
    let mac = cfg!(target_os = "macos");
    let arm = cfg!(target_arch = "aarch64");
    let version = mac
        .then(|| system_value("/usr/bin/sw_vers", &["-productVersion"]))
        .flatten();
    let chip = mac
        .then(|| system_value("/usr/sbin/sysctl", &["-n", "machdep.cpu.brand_string"]))
        .flatten();
    let memory = mac
        .then(|| system_value("/usr/sbin/sysctl", &["-n", "hw.memsize"]))
        .flatten()
        .and_then(|s| s.parse::<u64>().ok());
    let supported_os = version
        .as_deref()
        .and_then(|v| v.split('.').next()?.parse::<u32>().ok())
        .is_some_and(|v| v >= 14);
    let executable_path = std::env::current_exe().ok();
    let app_hash = executable_path
        .as_deref()
        .and_then(|path| file_hash(path).ok());
    let helper_hash = helper
        .filter(|path| executable(path))
        .and_then(|path| file_hash(path).ok());
    let registry: Value = serde_json::from_str(REGISTRY).expect("embedded model registry");
    let models: Vec<Value> = registry["images"].as_array().into_iter().flatten()
        .filter(|m| m["locality"] == "local")
        .map(|m| json!({"modelId":m["id"],"weightsSha256Expected":m["runtime"]["weights_sha256"],"minimumMacOS":m["runtime"]["minimum_macos"],"cacheStatus":"NOT_RUN"})).collect();
    let check = |id: &str, passed: bool, next: &str| json!({"id":id,"status":if passed {"PASS"} else {"FAIL"},"required":true,"next":if passed {""} else {next}});
    json!({
        "schema":SCHEMA,
        "runtimeKind":runtime_kind(executable_path.as_deref()),
        "platform":{"os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"macOS":version,"chip":chip,"memoryBytes":memory,"freeDiskBytes":free_disk_bytes()},
        "build":{"appSha256":app_hash,"gitSha":option_env!("MANGA_BUILD_GIT_SHA").unwrap_or("unknown"),"source":option_env!("MANGA_BUILD_SOURCE").unwrap_or("unknown"),"dirty":option_env!("MANGA_BUILD_DIRTY").map(|v|v=="true"),"version":env!("CARGO_PKG_VERSION")},
        "helper":{"sha256":helper_hash},
        "registry":{"sha256":hash(REGISTRY.as_bytes()),"models":models},
        "checks":[check("macOS_14_or_later",mac && supported_os,"macOS 14以降のMacで実行してください。"),check("apple_silicon",arm,"Apple Silicon用のアプリをMシリーズMacで実行してください。"),check("image_helper",helper_hash.is_some(),"画像ヘルパーを含む成功ビルドのDMGからアプリを入れ直してください。"),
            {"id":"model_cache","status":"NOT_RUN","required":false},
            {"id":"llm_connectivity","status":"NOT_RUN","required":false},
            {"id":"source_connectivity","status":"NOT_RUN","required":false},
            {"id":"scene_staging","status":"NOT_RUN","required":false}],
        "readOnly":true
    })
}
pub fn preflight_passed(report: &Value) -> bool {
    report["checks"].as_array().is_some_and(|checks| {
        checks
            .iter()
            .all(|c| c["required"] != true || c["status"] == "PASS")
    })
}
fn reject_links(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Acceptance storage links are not allowed".into())
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(err(e)),
        }
    }
    Ok(())
}
fn reject_tree_links(root: &Path) -> Result<()> {
    let mut pending = vec![root.to_owned()];
    let mut count = 0;
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path).map_err(err)? {
            let entry = entry.map_err(err)?;
            count += 1;
            if count > 100_000 {
                return Err("Acceptance session is too large".into());
            }
            let kind = entry.file_type().map_err(err)?;
            if kind.is_symlink() {
                return Err("Acceptance storage links are not allowed".into());
            }
            if kind.is_dir() {
                pending.push(entry.path());
            } else if !kind.is_file() {
                return Err("Acceptance storage must contain regular files".into());
            }
        }
    }
    Ok(())
}
pub fn fixture_project(data: &str) -> Result<()> {
    let project: Value = serde_json::from_str(data).map_err(err)?;
    if project["acceptanceFixture"] != FIXTURE {
        return Err("Acceptance session only accepts the synthetic fixture".into());
    }
    Ok(())
}
fn validate_database(root: &Path) -> Result<()> {
    let path = root.join("manga.sqlite3");
    if !path.exists() {
        return Ok(());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    // Reject unrelated and legacy SQLite files before normal schema initialization.
    let data: Option<String> = db
        .query_row("SELECT data FROM project WHERE id=1", [], |row| row.get(0))
        .optional()
        .map_err(err)?;
    if let Some(data) = data {
        fixture_project(&data)?;
    }
    Ok(())
}
fn stage_record(stage: &str, status: &str, evidence: &Value) -> Result<Value> {
    if !STAGES.contains(&stage) || !["PASS", "FAIL", "NOT_RUN"].contains(&status) {
        return Err("Invalid acceptance stage or status".into());
    }
    let evidence = evidence.as_object().ok_or("Invalid acceptance evidence")?;
    if evidence.len() > 16 {
        return Err("Too many evidence fields".into());
    }
    for (key, value) in evidence {
        let valid = match key.as_str() {
            "sha256" | "projectSha256" | "imageSha256" => value.as_str().is_some_and(valid_hash),
            "width" | "height" => value.as_u64().is_some_and(|n| n > 0 && n <= 16384),
            "bytes" => value.as_u64().is_some_and(|n| n <= 128 * 1024 * 1024),
            "elapsedMs" => value.as_u64().is_some_and(|n| n <= 7 * 24 * 3600 * 1000),
            "steps" => value.as_u64().is_some_and(|n| n <= 1000),
            "seed" => value.as_u64().is_some_and(|n| n <= u32::MAX as u64),
            "panelCount" | "pageCount" => value.as_u64().is_some_and(|n| n <= 10000),
            "modelId" => value.as_str().is_some_and(|id| {
                serde_json::from_str::<Value>(REGISTRY)
                    .ok()
                    .is_some_and(|r| {
                        r["images"].as_array().is_some_and(|ms| {
                            ms.iter().any(|m| m["id"] == id && m["locality"] == "local")
                        })
                    })
            }),
            _ => false,
        };
        if !valid {
            return Err("Unsupported acceptance evidence field or value".into());
        }
    }
    let next = if status == "FAIL" {
        match stage {
            "name_v2_compiler" => "このセッションを残し、アプリ版とネーム検査エラーを確認してください。",
            "fixture_save" | "fixture_reload" | "adoption" => "空き容量と保存エラーを確認し、同じセッションの保存済み結果から再開してください。",
            "generation" => "未取得なら通常アプリで6-bitモデルを準備してください。未確定要求は再送せず保存済み結果を回収してください。",
            "renderer" | "export_png" => "文字・出力エラーと空き容量を確認し、保存済み作画から再開してください。",
            "restart" => "同じUUIDとアプリ版で再起動したか確認し、hash不一致ならこのセッションを残してください。",
            _ => "Issue #266の対象受入項目を確認してください。",
        }
    } else {
        ""
    };
    Ok(json!({"status":status,"evidence":evidence,"next":next}))
}

pub struct Session {
    pub root: PathBuf,
    id: String,
    resumed: bool,
    report: Value,
    stages: Map<String, Value>,
    restart_baseline: Option<String>,
}
impl Session {
    /// The caller holds the returned workspace gate for the entire app lifetime.
    pub fn open(normal_base: &Path, id: &str, report: Value) -> Result<(Self, fs::File)> {
        if !valid_id(id) {
            return Err("Invalid acceptance session UUID".into());
        }
        let name = normal_base
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Missing app data directory")?;
        let parent = normal_base
            .parent()
            .ok_or("Missing app data parent")?
            .join(format!("{name}-acceptance"));
        let root = parent.join(id.to_ascii_lowercase());
        reject_links(&root)?;
        fs::create_dir_all(&parent).map_err(err)?;
        let resumed = match fs::create_dir(&root) {
            Ok(()) => false,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => true,
            Err(e) => return Err(err(e)),
        };
        reject_tree_links(&root)?;
        let marker = root.join("acceptance-session.json");
        if resumed {
            let marker: Value = super::backup::read_json(&marker)?;
            if marker
                != json!({"schema":SCHEMA,"sessionId":id.to_ascii_lowercase(),"fixture":FIXTURE})
            {
                return Err("Unrecognized acceptance session; choose a new UUID".into());
            }
        }
        let gate = super::backup::gate(&root, ".workspace.lock")?;
        if resumed {
            validate_database(&root)?;
        } else {
            super::backup::atomic_json(
                &marker,
                &json!({"schema":SCHEMA,"sessionId":id.to_ascii_lowercase(),"fixture":FIXTURE}),
            )?;
        }
        let launch_path = root.join("acceptance-launch.json");
        if resumed {
            let previous: Value = super::backup::read_json(&launch_path)?;
            if previous["build"] != report["build"]
                || previous["helper"] != report["helper"]
                || previous["registry"] != report["registry"]
            {
                return Err("Acceptance session belongs to a different app, helper or registry build; choose a new UUID".into());
            }
        } else {
            super::backup::atomic_json(&launch_path, &report)?;
        }
        let stages_path = root.join("acceptance-stages.json");
        let mut stages: Map<String, Value> = STAGES
            .iter()
            .map(|stage| (stage.to_string(), json!({"status":"NOT_RUN","evidence":{}})))
            .collect();
        if stages_path.exists() {
            let saved: Value = super::backup::read_json(&stages_path)?;
            for (name, value) in saved.as_object().ok_or("Invalid acceptance stages")? {
                stages.insert(
                    name.clone(),
                    stage_record(
                        name,
                        value["status"]
                            .as_str()
                            .ok_or("Invalid acceptance status")?,
                        &value["evidence"],
                    )?,
                );
            }
        }
        let restart_baseline = stages
            .get("adoption")
            .filter(|v| v["status"] == "PASS")
            .and_then(|v| v["evidence"]["projectSha256"].as_str())
            .map(str::to_owned);
        Ok((
            Self {
                root,
                id: id.to_ascii_lowercase(),
                resumed,
                report,
                stages,
                restart_baseline,
            },
            gate,
        ))
    }
    pub fn context(&self) -> Value {
        json!({"sessionId":self.id,"resumed":self.resumed,"report":self.report,"stages":self.stages,"restartBaseline":self.restart_baseline})
    }
    pub fn record(&mut self, stage: &str, status: &str, evidence: Value) -> Result<Value> {
        let value = stage_record(stage, status, &evidence)?;
        if stage == "restart" && status == "PASS" {
            let baseline = self
                .restart_baseline
                .as_deref()
                .ok_or("No adoption baseline from the previous launch")?;
            if !self.resumed || evidence["projectSha256"].as_str() != Some(baseline) {
                return Err(
                    "Restart verification requires a resumed session and matching saved hash"
                        .into(),
                );
            }
        }
        let mut next = self.stages.clone();
        next.insert(stage.to_owned(), value.clone());
        super::backup::atomic_json(&self.root.join("acceptance-stages.json"), &next)?;
        self.stages = next;
        self.finish()?;
        Ok(value)
    }
    pub fn export_png(&self, image: &str) -> Result<Value> {
        if image.len() > 90 * 1024 * 1024 {
            return Err("Acceptance PNG is too large".into());
        }
        let bytes = STANDARD
            .decode(
                image
                    .strip_prefix("data:image/png;base64,")
                    .ok_or("Expected PNG data URL")?,
            )
            .map_err(|_| "Invalid PNG encoding")?;
        if bytes.len() > 64 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Invalid acceptance PNG".into());
        }
        let decoder = png::Decoder::new(std::io::Cursor::new(&bytes));
        let mut reader = decoder.read_info().map_err(|_| "Invalid PNG header")?;
        let width = reader.info().width;
        let height = reader.info().height;
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            return Err("Invalid PNG dimensions".into());
        }
        let decoded_size = reader
            .output_buffer_size()
            .filter(|size| *size <= 64 * 1024 * 1024)
            .ok_or("Acceptance PNG expands beyond limit")?;
        let mut pixels = vec![0; decoded_size];
        reader
            .next_frame(&mut pixels)
            .map_err(|_| "Invalid PNG image data")?;
        reader.finish().map_err(|_| "Incomplete PNG image")?;
        let sha = hash(&bytes);
        let target = self.root.join(format!("page-{sha}.png"));
        use std::io::Write;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(err)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                reject_links(&target)?;
                if file_hash(&target)? != sha {
                    return Err("PNG evidence hash mismatch".into());
                }
            }
            Err(e) => return Err(err(e)),
        }
        Ok(json!({"sha256":sha,"bytes":bytes.len(),"width":width,"height":height}))
    }
    pub fn finish(&self) -> Result<Value> {
        let path = self.root.join("acceptance-report.json");
        let mut report = self.report.clone();
        report["readOnly"] = json!(false);
        report["sessionId"] = json!(self.id);
        report["resumed"] = json!(self.resumed);
        report["stages"] = json!(self.stages);
        report["scope"] = json!("synthetic-fixture");
        super::backup::atomic_json(&path, &report)?;
        Ok(json!({"reportPath":path}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf {
        let path = std::env::temp_dir().join(format!("acceptance-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path.canonicalize().unwrap()
    }
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    #[test]
    fn arguments_never_fall_back_when_acceptance_is_malformed() {
        assert_eq!(parse_args(&[]).unwrap(), Mode::Normal);
        assert_eq!(
            parse_args(&["--acceptance-preflight".into()]).unwrap(),
            Mode::Preflight
        );
        for args in [
            vec!["--acceptance-session".into()],
            vec!["--acceptance-session".into(), "../../data".into()],
            vec!["--acceptance-session=x".into()],
            vec!["--acceptance-preflight".into(), "extra".into()],
        ] {
            assert!(parse_args(&args).is_err());
        }
    }
    #[test]
    fn diagnostic_does_not_create_files_or_claim_unrun_checks() {
        let report = preflight(None);
        assert_eq!(report["checks"][2]["status"], "FAIL");
        for check in report["checks"].as_array().unwrap().iter().skip(3) {
            assert_eq!(check["status"], "NOT_RUN");
        }
        assert!(report["helper"]["sha256"].is_null());
        assert!(!preflight_passed(&report));
    }
    #[test]
    fn sessions_are_isolated_exclusive_and_reject_unmarked_or_real_databases() {
        let temp = temporary();
        let normal = temp.join("app");
        let uuid = id();
        let (session, gate) = Session::open(&normal, &uuid, preflight(None)).unwrap();
        assert!(!normal.exists());
        assert!(!session.resumed);
        assert!(Session::open(&normal, &uuid, preflight(None)).is_err());
        drop(gate);
        let (resumed, gate) = Session::open(&normal, &uuid, preflight(None)).unwrap();
        assert!(resumed.resumed);
        let db = Connection::open(resumed.root.join("manga.sqlite3")).unwrap();
        super::super::initialize(&db).unwrap();
        db.execute(
            "INSERT INTO project VALUES(1,?1)",
            [r#"{"version":5,"title":"real project"}"#],
        )
        .unwrap();
        drop(db);
        drop(gate);
        assert!(Session::open(&normal, &uuid, preflight(None)).is_err());
        let other = id();
        fs::create_dir(temp.join("app-acceptance").join(&other)).unwrap();
        assert!(Session::open(&normal, &other, preflight(None)).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn only_allowlisted_evidence_is_saved_and_restart_requires_second_launch() {
        let temp = temporary();
        let normal = temp.join("app");
        let uuid = id();
        let (mut session, gate) = Session::open(&normal, &uuid, preflight(None)).unwrap();
        assert!(session
            .record("fixture_save", "PASS", json!({"token":"secret"}))
            .is_err());
        let evidence = json!({"projectSha256":"a".repeat(64),"panelCount":1});
        session
            .record("adoption", "PASS", evidence.clone())
            .unwrap();
        assert!(session.record("restart", "PASS", evidence.clone()).is_err());
        drop(gate);
        let (mut resumed, gate) = Session::open(&normal, &uuid, preflight(None)).unwrap();
        resumed.record("restart", "PASS", evidence).unwrap();
        assert!(resumed
            .record("restart", "PASS", json!({"projectSha256":"b".repeat(64)}))
            .is_err());
        let report = fs::read_to_string(resumed.root.join("acceptance-report.json")).unwrap();
        assert!(!report.contains("secret"));
        drop(gate);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn restart_cannot_accept_an_adoption_created_during_this_launch() {
        let temp = temporary();
        let normal = temp.join("app");
        let uuid = id();
        let (_, gate) = Session::open(&normal, &uuid, preflight(None)).unwrap();
        drop(gate);
        let (mut resumed, gate) = Session::open(&normal, &uuid, preflight(None)).unwrap();
        let evidence = json!({"projectSha256":"a".repeat(64)});
        resumed
            .record("adoption", "PASS", evidence.clone())
            .unwrap();
        assert!(resumed.record("restart", "PASS", evidence).is_err());
        drop(gate);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn a_different_binary_or_helper_cannot_resume_the_same_evidence() {
        let temp = temporary();
        let normal = temp.join("app");
        let uuid = id();
        let report = preflight(None);
        let (_, gate) = Session::open(&normal, &uuid, report.clone()).unwrap();
        drop(gate);
        let mut changed = report;
        changed["build"]["appSha256"] = json!("f".repeat(64));
        assert!(Session::open(&normal, &uuid, changed).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn png_evidence_is_decoded_hashed_and_only_written_in_the_session() {
        let temp = temporary();
        let normal = temp.join("app");
        let uuid = id();
        let (session, gate) = Session::open(&normal, &uuid, preflight(None)).unwrap();
        assert!(session
            .export_png("data:image/png;base64,aGVsbG8=")
            .is_err());
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[0, 0, 0, 255]).unwrap();
        }
        let data = format!("data:image/png;base64,{}", STANDARD.encode(&bytes));
        let evidence = session.export_png(&data).unwrap();
        assert_eq!(evidence["sha256"], hash(&bytes));
        assert_eq!(evidence["width"], 1);
        assert_eq!(session.export_png(&data).unwrap(), evidence);
        assert_eq!(
            fs::read(session.root.join(format!("page-{}.png", hash(&bytes)))).unwrap(),
            bytes
        );
        let truncated = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(&bytes[..bytes.len() / 2])
        );
        assert!(session.export_png(&truncated).is_err());
        assert!(!normal.exists());
        drop(gate);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn runtime_kind_reports_only_bundle_structure_without_the_path() {
        assert_eq!(
            runtime_kind(Some(Path::new(
                "/Applications/Manga Mac.app/Contents/MacOS/manga-mac"
            ))),
            "app-bundle"
        );
        assert_eq!(
            runtime_kind(Some(Path::new("/tmp/manga-mac"))),
            "standalone-binary"
        );
        assert_eq!(
            runtime_kind(Some(Path::new("/tmp/manga-mac/Contents/MacOS/manga-mac"))),
            "standalone-binary"
        );
    }
    #[test]
    fn acceptance_v2_fixture_roundtrips_before_and_after_finalization() {
        use super::super::{load, save_checked, tests::setup};
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/acceptance-name-v2.json"))
                .unwrap();
        let (mut db, root) = setup();
        let before = fixture["before"].clone();
        fixture_project(&before.to_string()).unwrap();
        save_checked(&mut db, &root, &before.to_string()).unwrap();
        let restored: Value = serde_json::from_str(&load(&db, &root).unwrap().unwrap()).unwrap();
        for key in [
            "acceptanceFixture",
            "namePlan",
            "panels",
            "layout",
            "sourceApplication",
        ] {
            assert_eq!(restored[key], before[key], "{key}");
        }
        let mut complete = fixture["complete"].clone();
        complete["contentToken"] = restored["contentToken"].clone();
        fixture_project(&complete.to_string()).unwrap();
        save_checked(&mut db, &root, &complete.to_string()).unwrap();
        let raw = load(&db, &root).unwrap().unwrap();
        let final_project: Value = serde_json::from_str(&raw).unwrap();
        for key in [
            "acceptanceFixture",
            "namePlan",
            "panels",
            "layout",
            "sourceApplication",
            "artworks",
            "jobs",
        ] {
            assert_eq!(final_project[key], complete[key], "{key}");
        }
        let policy = &final_project["sourceApplication"]["units"][0];
        assert_eq!(policy["requiredText"].as_array().unwrap().len(), 2);
        assert_eq!(policy["requiredText"][0]["startCp"], 0);
        assert_eq!(policy["requiredText"][0]["endCp"], 6);
        assert_eq!(policy["requiredText"][1]["startCp"], 6);
        assert_eq!(policy["requiredText"][1]["endCp"], 17);
        // Equivalent text coverage is insufficient: the compiler's atom policy is authoritative.
        let mut bad = final_project.clone();
        bad["sourceApplication"]["units"][0]["requiredText"] = json!([policy["source"]]);
        let error = save_checked(&mut db, &root, &bad.to_string()).unwrap_err();
        assert_eq!(error, "Applied text differs from the approved name policy");
        assert_eq!(load(&db, &root).unwrap().unwrap(), raw);
        save_checked(&mut db, &root, &final_project.to_string()).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlink_session_root_or_file_is_refused() {
        let temp = temporary();
        let normal = temp.join("app");
        let uuid = id();
        let (session, gate) = Session::open(&normal, &uuid, preflight(None)).unwrap();
        drop(gate);
        std::os::unix::fs::symlink(&normal, session.root.join("escape")).unwrap();
        assert!(Session::open(&normal, &uuid, preflight(None)).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
}
