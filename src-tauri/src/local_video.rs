//! Local CLI adapter; no model downloads, shell, HTTP client or provider fallback.
use crate::{runway, storage};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tokio::process::Command;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub executable: PathBuf,
    pub model_dir: PathBuf,
    pub ffmpeg: PathBuf,
    pub approved: bool,
}

fn executable(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("実行ファイルの絶対パスを指定してください".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("実行権限がありません".into());
        }
    }
    // Keep the venv executable's spelling (symlink resolution can escape its venv).
    Ok(path.to_owned())
}

pub fn validate_config(mut input: Registration) -> Result<Registration, String> {
    if !input.approved {
        return Err("ローカル実行の許可が必要です".into());
    }
    input.executable = executable(&input.executable)?;
    input.ffmpeg = executable(&input.ffmpeg)?;
    if !input.model_dir.is_absolute() || !input.model_dir.is_dir() {
        return Err("取得済みLTX-2.5モデルの絶対パスを指定してください".into());
    }
    input.model_dir = input.model_dir.canonicalize().map_err(|e| e.to_string())?;
    for name in [
        "text_encoder.safetensors",
        "transformer-distilled.safetensors",
        "spatial_upscaler_x2_v1_0.safetensors",
        "tokenizer.json",
        "tokenizer_config.json",
    ] {
        if !input.model_dir.join(name).is_file() {
            return Err(format!(
                "モデルに {name} がありません。完全なLTX-2.5 q4 packを事前取得してください"
            ));
        }
    }
    let config_path = ["embedded_config.json", "config.json"]
        .into_iter()
        .map(|name| input.model_dir.join(name))
        .find(|p| p.is_file())
        .ok_or("モデル設定がありません")?;
    if fs::metadata(&config_path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("モデル設定が大きすぎます".into());
    }
    let config: Value = serde_json::from_slice(&fs::read(config_path).map_err(|e| e.to_string())?)
        .map_err(|_| "モデル設定が不正です")?;
    let transformer = config.get("transformer").unwrap_or(&config);
    if transformer["ff_bias"] != false {
        return Err("LTX-2.5のモデル設定（ff_bias=false）が必要です".into());
    }
    Ok(input)
}

pub const RATIOS: [&str; 3] = ["512:512", "512:320", "320:512"];

fn validate_input(manifest: &Value, image: &str, end: Option<&str>) -> Result<Vec<u8>, String> {
    let allowed = [
        "version",
        "scope",
        "source",
        "characterIds",
        "sourceDependencies",
        "providerInputs",
        "prompt",
        "duration",
        "ratio",
        "connection",
        "base_revision",
    ];
    let inputs = manifest["providerInputs"]
        .as_array()
        .ok_or("開始画像がありません")?;
    if !manifest
        .as_object()
        .is_some_and(|m| m.keys().all(|k| allowed.contains(&k.as_str())))
        || end.is_some()
        || inputs.len() != 1
        || manifest["version"] != 1
        || manifest["connection"]["provider"] != "ltx-mlx"
        || manifest["connection"]["model"] != "ltx-2.5"
        || manifest["duration"] != 5
        || inputs[0]["role"] != "start_frame"
        || inputs[0]["media_type"] != "image"
        || inputs[0]["mime"] != "image/png"
        || inputs[0]["transform"] != json!({"kind":"identity"})
    {
        return Err("LTX-2.5 MLXは開始画像1枚・5秒のみ対応します。終端画像は送信しません".into());
    }
    let ratio = manifest["ratio"].as_str().ok_or("寸法がありません")?;
    let prompt = manifest["prompt"].as_str().ok_or("指示がありません")?;
    if !RATIOS.contains(&ratio) || prompt.trim().is_empty() || prompt.encode_utf16().count() > 1000
    {
        return Err(
            "ローカル動画は512:512 / 512:320 / 320:512と1000文字以内の指示に対応します".into(),
        );
    }
    Ok(runway::frame_bytes(&inputs[0], image, ratio, "開始画像")?.0)
}

fn command(exe: &Path, config: &Registration, dir: &Path) -> Command {
    let mut cmd = Command::new(exe);
    cmd.current_dir(dir)
        .env_clear()
        .env(
            "PATH",
            format!(
                "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                config
                    .ffmpeg
                    .parent()
                    .unwrap_or(Path::new("/usr/bin"))
                    .display()
            ),
        )
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("DO_NOT_TRACK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Required by Python/macOS caches; API credentials and proxy env are not inherited.
    if let Some(home) = std::env::var_os("HOME") {
        cmd.env("HOME", home);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

async fn execute(cmd: &mut Command, seconds: u64, stage: &str) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|_| {
        format!("{stage}を起動できません。実行ファイル・依存関係を確認してください")
    })?;
    let _group = ProcessGroup(child.id().ok_or("プロセスIDがありません")?);
    match tokio::time::timeout(Duration::from_secs(seconds), child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => Err(format!("{stage}に失敗しました。モデル一式・CLI互換性・空きメモリを確認してください（自動再実行なし）")),
        Err(_) => {
            let _ = child.kill().await;
            Err(format!("{stage}が制限時間を超えました。処理を停止しました（自動再実行なし）"))
        }
    }
}

struct WorkDir(PathBuf);
impl Drop for WorkDir {
    fn drop(&mut self) {
        // Only adapter-owned files; never recursively delete model/user directories.
        for name in ["start.png", "generated.mp4", "silent.mp4"] {
            let _ = fs::remove_file(self.0.join(name));
        }
        let _ = fs::remove_dir(&self.0);
    }
}

async fn render(
    config: &Registration,
    root: &Path,
    manifest: &Value,
    bytes: &[u8],
) -> Result<Value, String> {
    let work = WorkDir(root.join(format!("local-video-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&work.0).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&work.0, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    fs::write(work.0.join("start.png"), bytes).map_err(|e| e.to_string())?;
    let (width, height) = manifest["ratio"]
        .as_str()
        .ok_or("寸法がありません")?
        .split_once(':')
        .ok_or("寸法が不正です")?;
    let mut generate = command(&config.executable, config, &work.0);
    generate
        .args(["generate", "--distilled", "--low-ram", "--model"])
        .arg(&config.model_dir)
        .args([
            "--prompt",
            manifest["prompt"].as_str().ok_or("指示がありません")?,
            "--image",
            "start.png",
            "-W",
            width,
            "-H",
            height,
            "-f",
            "121",
            "--frame-rate",
            "24",
            "--seed",
            "42",
            "-o",
            "generated.mp4",
        ]);
    execute(&mut generate, 3600, "LTX-2.5 MLX生成").await?;
    let raw = work.0.join("generated.mp4");
    if !fs::symlink_metadata(&raw)
        .map_err(|_| "生成MP4がありません")?
        .file_type()
        .is_file()
        || fs::metadata(&raw).map_err(|e| e.to_string())?.len() > storage::MAX_VIDEO_BYTES
    {
        return Err("生成MP4の形式・サイズが不正です".into());
    }
    let mut encode = command(&config.ffmpeg, config, &work.0);
    encode.args([
        "-nostdin",
        "-v",
        "error",
        "-n",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        "generated.mp4",
        "-map",
        "0:v:0",
        "-an",
        "-t",
        "5",
        "-r",
        "24",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "silent.mp4",
    ]);
    execute(&mut encode, 120, "無音MP4変換").await?;
    let path = work.0.join("silent.mp4");
    let probe_path = path.clone();
    let meta = tokio::task::spawn_blocking(move || storage::live_export::probe(&probe_path))
        .await
        .map_err(|e| e.to_string())??;
    if meta["codec"] != "h264"
        || meta["audio"] != false
        || meta["width"].as_u64() != width.parse().ok()
        || meta["height"].as_u64() != height.parse().ok()
        || !(4.9..=5.1).contains(&meta["duration"].as_f64().unwrap_or(0.0))
    {
        return Err("生成結果が指定寸法・5秒・H.264・無音に一致しません".into());
    }
    storage::put_video(root, fs::File::open(path).map_err(|e| e.to_string())?, None)
}

pub async fn submit(
    db: &Mutex<Connection>,
    root: &Path,
    id: &str,
    connection_id: &str,
    config: &Registration,
    image: &str,
    end: Option<&str>,
) -> Result<Value, String> {
    let config = validate_config(config.clone())?;
    let mut manifest = Value::Null;
    let mut bytes = Vec::new();
    {
        let mut db = db.lock().map_err(|e| e.to_string())?;
        storage::update_remote_job(&mut db, id, |project, job| {
            runway::validate_pending_job(project, job, connection_id)?;
            if project["jobs"].as_array().is_some_and(|jobs| {
                jobs.iter().any(|other| {
                    other["id"] != job["id"]
                        && other["manifest"]["connection"]["provider"] == "ltx-mlx"
                        && other["status"] != "abandoned"
                        && other["remote"]["status"] == "unknown"
                })
            }) {
                return Err("別ショットの未確定ローカル要求があります。処理の停止を確認して解決してください".into());
            }
            if job["kind"] != "video" || job["scope"] != job["manifest"]["scope"] {
                return Err("動画要求の対象が不正です".into());
            }
            manifest = job["manifest"].clone();
            bytes = validate_input(&manifest, image, end)?;
            Ok(
                json!({"provider":"ltx-mlx", "status":"unknown", "preset":"distilled-low-ram-v1", "frames":121, "fps":24, "seed":42}),
            )
        })?;
    }
    // Reservation is durable before spawning. Restart never repeats inference.
    let result = render(&config, root, &manifest, &bytes).await;
    let mut db = db.lock().map_err(|e| e.to_string())?;
    storage::update_remote_job(&mut db, id, |_, job| {
        let mut remote = job["remote"].clone();
        match &result {
            Ok(artifact) => {
                remote["status"] = json!("SUCCEEDED");
                remote["artifact"] = artifact.clone();
            }
            Err(error) => {
                remote["status"] = json!("FAILED");
                remote["error"] = json!(error);
            }
        }
        Ok(remote)
    })?;
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        root: PathBuf,
        config: Registration,
        image: String,
        manifest: Value,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn fixture() -> Fixture {
        let root =
            std::env::temp_dir().join(format!("manga-local-video-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let models = root.join("models");
        fs::create_dir(&models).unwrap();
        for name in [
            "text_encoder.safetensors",
            "transformer-distilled.safetensors",
            "spatial_upscaler_x2_v1_0.safetensors",
            "tokenizer.json",
            "tokenizer_config.json",
        ] {
            fs::write(models.join(name), b"fixture, not weights").unwrap();
        }
        fs::write(
            models.join("config.json"),
            br#"{"transformer":{"ff_bias":false}}"#,
        )
        .unwrap();
        let ffmpeg = [
            "/usr/bin/ffmpeg",
            "/opt/homebrew/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
        ]
        .into_iter()
        .find(|p| Path::new(p).is_file())
        .expect("Install ffmpeg for native fixtures");
        let exe = root.join("fake-ltx");
        fs::write(&exe, format!("#!/bin/sh\nset -eu\n[ \"$HF_HUB_OFFLINE\" = 1 ]\n[ \"$TRANSFORMERS_OFFLINE\" = 1 ]\n[ -z \"${{HTTPS_PROXY:-}}\" ]\n[ -f start.png ]\n[ \"$1\" = generate ]\n[ \"$2\" = --distilled ]\n[ \"$3\" = --low-ram ]\nexec '{ffmpeg}' -nostdin -v error -f lavfi -i color=c=blue:s=512x512:r=24 -frames:v 121 -c:v libx264 -pix_fmt yuv420p generated.mp4\n")).unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
        let legacy: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/legacy-v1.json")).unwrap();
        let image = legacy["panels"][0]["image"].as_str().unwrap().to_owned();
        let bytes = STANDARD.decode(image.split_once(',').unwrap().1).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let manifest = json!({"version":1,"scope":{"type":"videoShot","id":"v"},"connection":{"id":"c","provider":"ltx-mlx","model":"ltx-2.5"},"duration":5,"ratio":"512:512","prompt":"Slow push; $(touch injected)","source":{"snapshotId":"source","commit":"sha","sceneId":"s","unitIds":["u"]},"characterIds":[],"base_revision":null,"providerInputs":[{"id":"a","hash":hash,"size":bytes.len(),"role":"start_frame","media_type":"image","mime":"image/png","transform":{"kind":"identity"}}]});
        Fixture {
            config: Registration {
                executable: exe,
                model_dir: models,
                ffmpeg: ffmpeg.into(),
                approved: true,
            },
            root,
            image,
            manifest,
        }
    }
    fn database(f: &Fixture) -> Mutex<Connection> {
        let db = Connection::open_in_memory().unwrap();
        storage::initialize(&db).unwrap();
        let m = &f.manifest;
        let job = json!({"id":"j","kind":"video","scope":m["scope"],"manifest":m,"status":"running","base_revision":null,"source_revision":"source","active_snapshot":"source"});
        let project = json!({"active":"source","snapshots":[{"id":"source","sha":"sha"}],"jobs":[job],"videoShots":[{"id":"v","adopted_revision":null,"snapshotId":"source","sceneId":"s","unitIds":["u"],"characterIds":[],"prompt":m["prompt"],"ratio":m["ratio"],"duration":5,"startImage":{"id":"a","hash":m["providerInputs"][0]["hash"]}}]});
        db.execute("INSERT INTO project VALUES(1,?1)", [project.to_string()])
            .unwrap();
        Mutex::new(db)
    }

    #[test]
    fn explicit_paths_consent_and_25_pack_are_required() {
        let f = fixture();
        assert!(validate_config(f.config.clone()).is_ok());
        let mut c = f.config.clone();
        c.approved = false;
        assert!(validate_config(c).is_err());
        let mut c = f.config.clone();
        c.executable = "ltx-2-mlx".into();
        assert!(validate_config(c).is_err());
        let mut c = f.config.clone();
        c.model_dir = "dgrauet/ltx-2.5-mlx-q4".into();
        assert!(validate_config(c).is_err());
        fs::write(
            f.config.model_dir.join("config.json"),
            br#"{"ff_bias":true}"#,
        )
        .unwrap();
        assert!(validate_config(f.config.clone()).is_err());
    }

    #[test]
    fn reject_end_frame_hash_ratio_and_unrecognized_controls() {
        let f = fixture();
        assert!(validate_input(&f.manifest, &f.image, None).is_ok());
        assert!(validate_input(&f.manifest, &f.image, Some(&f.image)).is_err());
        for (key, value) in [
            ("ratio", json!("960:960")),
            ("duration", json!(6)),
            ("prompt", json!("")),
            ("transition", json!({})),
            ("unknown", json!(true)),
        ] {
            let mut m = f.manifest.clone();
            m[key] = value;
            assert!(validate_input(&m, &f.image, None).is_err());
        }
        let mut m = f.manifest.clone();
        m["providerInputs"][0]["hash"] = json!("wrong");
        assert!(validate_input(&m, &f.image, None).is_err());
    }

    #[tokio::test]
    async fn fixture_cli_to_real_ffmpeg_to_immutable_artifact_no_replay() {
        let f = fixture();
        let db = database(&f);
        let artifact = submit(&db, &f.root, "j", "c", &f.config, &f.image, None)
            .await
            .unwrap();
        let path = storage::verify_video(&f.root, &artifact).unwrap();
        let meta = storage::live_export::probe(&path).unwrap();
        assert_eq!(meta["width"], 512);
        assert_eq!(meta["audio"], false);
        assert_eq!(meta["codec"], "h264");
        let p = storage::raw_project(&db.lock().unwrap()).unwrap();
        assert_eq!(p["jobs"][0]["remote"]["artifact"], artifact);
        assert_eq!(p["jobs"][0]["remote"]["status"], "SUCCEEDED");
        assert!(p["videoShots"][0]["adopted_revision"].is_null());
        assert!(submit(&db, &f.root, "j", "c", &f.config, &f.image, None)
            .await
            .is_err());
        assert!(!f.root.join("injected").exists());
        assert!(!fs::read_dir(&f.root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("local-video-")));
    }

    #[tokio::test]
    async fn failed_cli_is_durable_and_does_not_fallback_or_retry() {
        let f = fixture();
        let db = database(&f);
        fs::write(&f.config.executable, "#!/bin/sh\nexit 7\n").unwrap();
        assert!(submit(&db, &f.root, "j", "c", &f.config, &f.image, None)
            .await
            .is_err());
        let p = storage::raw_project(&db.lock().unwrap()).unwrap();
        assert_eq!(p["jobs"][0]["remote"]["status"], "FAILED");
        assert!(p["jobs"][0]["remote"]["artifact"].is_null());
        assert!(submit(&db, &f.root, "j", "c", &f.config, &f.image, None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn timeout_is_bounded_and_reservation_rejects_stale_input() {
        let f = fixture();
        let db = database(&f);
        let mut cmd = command(Path::new("/bin/sh"), &f.config, &f.root);
        cmd.args(["-c", "sleep 30"]);
        assert!(execute(&mut cmd, 0, "fixture")
            .await
            .unwrap_err()
            .contains("制限時間"));
        let mut p = storage::raw_project(&db.lock().unwrap()).unwrap();
        p["videoShots"][0]["prompt"] = json!("changed");
        db.lock()
            .unwrap()
            .execute("UPDATE project SET data=?1 WHERE id=1", [p.to_string()])
            .unwrap();
        assert!(submit(&db, &f.root, "j", "c", &f.config, &f.image, None)
            .await
            .is_err());
        assert!(storage::raw_project(&db.lock().unwrap()).unwrap()["jobs"][0]["remote"].is_null());
    }
}
