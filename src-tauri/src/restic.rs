//! Thin adapter: restic owns encryption, transfer, repository locks and pruning.
use super::*;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const OWNER: &str = "manga-mac-backup-v1";
pub const RESTIC_VERSION: &str = "0.19.1";
pub const RCLONE_VERSION: &str = "v1.75.1";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub repository: String,
    pub restic: PathBuf,
    pub restic_hash: String,
    pub rclone: PathBuf,
    pub rclone_hash: String,
    pub rclone_config: PathBuf,
    pub destination: String,
    pub enabled: bool,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Status {
    pub phase: String,
    pub last_attempt: u64,
    pub last_success: u64,
    pub last_verified: u64,
    pub last_maintenance: u64,
    pub next_attempt: u64,
    pub failures: u32,
    pub cleanup: String,
    pub failure: String,
    pub saved_revision: Option<u64>,
    pub saved_fingerprint: String,
    pub snapshot: String,
}
pub fn status(root: &Path) -> Result<Status> {
    let p = root.join("backup-status.json");
    if p.exists() {
        read_json(&p)
    } else {
        Ok(Status::default())
    }
}
pub fn save_status(root: &Path, s: &Status) -> Result<()> {
    atomic_json(&root.join("backup-status.json"), s)
}
pub fn config(root: &Path) -> Result<Config> {
    read_json(&root.join("backup-config.json"))
}
pub fn validate_repository(repository: &str) -> Result<()> {
    let rest = repository
        .strip_prefix("rclone:")
        .ok_or("Google Drive/OneDriveのrclone保存先を指定してください")?;
    let (remote, path) = rest
        .split_once(':')
        .ok_or("保存先は rclone:remote:manga-mac-backups/名前 の形式です")?;
    if remote.is_empty()
        || !remote
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        || !path.starts_with("manga-mac-backups/")
        || !relative(path)
        || path.split('/').count() < 2
        || !path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-/".contains(&c))
    {
        return Err("アプリ専用領域 manga-mac-backups/名前 を指定してください".into());
    }
    Ok(())
}
pub fn key_id(c: &Config) -> String {
    format!("backup-{}", hash(c.repository.as_bytes()))
}
#[cfg(target_os = "macos")]
pub fn store_password(c: &Config, password: &str) -> Result<()> {
    if password.len() < 12 || password.contains('\n') || password.contains('\r') {
        return Err("復元用パスワードは改行なし12文字以上にしてください".into());
    }
    security_framework::passwords::set_generic_password(
        "com.kdob1042.manga-mac.backup",
        &key_id(c),
        password.as_bytes(),
    )
    .map_err(|_| "Keychainへ保存できません".into())
}
#[cfg(target_os = "macos")]
pub fn password(c: &Config) -> Result<Vec<u8>> {
    security_framework::passwords::generic_password(
        security_framework::passwords::PasswordOptions::new_generic_password(
            "com.kdob1042.manga-mac.backup",
            &key_id(c),
        ),
    )
    .map_err(|_| "Keychainを解除するか、保存先を再接続してください".into())
}
#[cfg(not(target_os = "macos"))]
pub fn store_password(_: &Config, _: &str) -> Result<()> {
    Err("Keychain設定はMacアプリ限定です".into())
}
#[cfg(not(target_os = "macos"))]
pub fn password(_: &Config) -> Result<Vec<u8>> {
    Err("KeychainはMacアプリ限定です".into())
}
async fn bounded(reader: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    reader
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut output)
        .await
        .map_err(|_| "バックアップ処理の応答を読めません")?;
    if output.len() > 16 * 1024 * 1024 {
        return Err("バックアップ処理の応答が上限を超えました".into());
    }
    Ok(output)
}
// No shell, inherited credentials, raw stderr, or password arguments. Password
// travels over an anonymous stdin pipe; rclone's stdin is its own protocol pipe.
async fn process(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    input: &[u8],
    c: Option<&Config>,
) -> Result<Vec<u8>> {
    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(c) = c {
        command.env("RCLONE_CONFIG", &c.rclone_config);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "restic/rcloneを起動できません。導入手順を確認してください")?;
    let mut stdin = child.stdin.take().ok_or("Missing process stdin")?;
    let stdout = child.stdout.take().ok_or("Missing process stdout")?;
    let result=tokio::time::timeout(std::time::Duration::from_secs(3600),async {
        stdin.write_all(input).await.map_err(|_|"パスワードを渡せません")?;stdin.shutdown().await.map_err(|_|"パスワード入力を終了できません")?;drop(stdin);
        let output=bounded(stdout).await?;
        let exit=child.wait().await.map_err(|_|"処理結果を確認できません")?;
        if !exit.success(){return Err(format!("バックアップコマンドが失敗しました（終了値 {}）。接続・認証・空き容量を確認してください。旧正常版は保持されます",exit.code().unwrap_or(-1)));} Ok(output)
    }).await;
    match result {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill().await;
            Err("バックアップが時間切れになりました。旧正常版を保持します".into())
        }
    }
}
pub async fn tools(c: &mut Config, cwd: &Path, pin: bool) -> Result<()> {
    for (path, expected, version, command) in [
        (&c.restic, &mut c.restic_hash, RESTIC_VERSION, "version"),
        (&c.rclone, &mut c.rclone_hash, RCLONE_VERSION, "version"),
    ] {
        if !path.is_absolute() {
            return Err("実行ファイルは絶対パスで指定してください".into());
        }
        let actual = digest(path)?.hash;
        if pin {
            *expected = actual;
        } else if actual != *expected {
            return Err(
                "導入済みツールが変更されました。公式配布物を検証して再設定してください".into(),
            );
        }
        let output = process(path, &[command.into()], cwd, b"", None).await?;
        let text = String::from_utf8(output).map_err(|_| "Invalid version")?;
        if !text
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .any(|v| v == version)
        {
            return Err(format!("採用版 {version} を導入してください"));
        }
    }
    if !c.rclone_config.is_absolute() {
        return Err("rclone設定は絶対パスで指定してください".into());
    }
    regular(&c.rclone_config)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&c.rclone_config)
            .map_err(err)?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            return Err("rclone設定の権限を600（自分だけ読書き可）へ変更してください".into());
        }
    }
    // Limit to a preconfigured drive/onedrive remote, with no shell/password-command support.
    let raw = fs::read_to_string(&c.rclone_config).map_err(|_| "rclone設定を読み込めません")?;
    if raw.len() > 1024 * 1024
        || raw.contains("password_command")
        || raw.contains("RCLONE_ENCRYPT_V")
    {
        return Err(
            "専用のrclone設定ファイルを指定してください（暗号化設定ファイルは初期版未対応）".into(),
        );
    }
    let remote = c
        .repository
        .strip_prefix("rclone:")
        .and_then(|v| v.split(':').next())
        .unwrap_or("");
    let mut active = false;
    let mut kind = None;
    for line in raw.lines().map(str::trim) {
        if line.starts_with('[') {
            active = line == format!("[{remote}]");
        } else if active {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == "type" {
                    kind = Some(v.trim().to_owned());
                }
            }
        }
    }
    if !matches!(kind.as_deref(), Some("drive" | "onedrive")) {
        return Err("Google DriveまたはOneDriveの専用remoteが必要です".into());
    }
    Ok(())
}
pub struct Client {
    pub config: Config,
    secret: Vec<u8>,
    pub work: PathBuf,
}
impl Drop for Client {
    fn drop(&mut self) {
        self.secret.fill(0);
    }
}
impl Client {
    pub fn new(config: Config, secret: Vec<u8>, work: PathBuf) -> Self {
        Self {
            config,
            secret,
            work,
        }
    }
    pub async fn run(&self, args: &[&str], cwd: Option<&Path>) -> Result<Vec<u8>> {
        let mut command = vec![
            "--repo".into(),
            self.config.repository.clone(),
            "--password-file".into(),
            "/dev/stdin".into(),
            "--no-cache".into(),
            "--retry-lock".into(),
            "30s".into(),
        ];
        if self.config.repository.starts_with("rclone:") {
            command.extend([
                "-o".into(),
                format!("rclone.program={}", self.config.rclone.display()),
            ]);
        }
        command.extend(args.iter().map(|s| s.to_string()));
        let mut input = self.secret.clone();
        input.push(b'\n');
        let result = process(
            &self.config.restic,
            &command,
            cwd.unwrap_or(&self.work),
            &input,
            Some(&self.config),
        )
        .await;
        input.fill(0);
        result
    }
    pub async fn destination(&self) -> Result<String> {
        let value: Value = serde_json::from_slice(&self.run(&["cat", "config"], None).await?)
            .map_err(|_| "保存先を識別できません")?;
        let id = value["id"].as_str().ok_or("保存先IDがありません")?;
        if !valid_hash(id) {
            return Err("保存先IDが不正です".into());
        }
        Ok(id.into())
    }
    pub async fn check_destination(&self) -> Result<()> {
        if self.destination().await? != self.config.destination {
            return Err("バックアップ先が別のrepositoryに変わっています".into());
        }
        Ok(())
    }
    pub async fn snapshots(&self) -> Result<Vec<Snapshot>> {
        self.check_destination().await?;
        let values: Vec<Value> =
            serde_json::from_slice(&self.run(&["snapshots", "--json"], None).await?)
                .map_err(|_| "履歴を取得できません")?;
        Ok(values
            .iter()
            .filter_map(|v| Snapshot::parse(v, &self.config.destination))
            .collect())
    }
    pub async fn fetch(&self, id: &str) -> Result<Temp> {
        if !valid_hash(id) {
            return Err("不正なsnapshot IDです".into());
        }
        let size: Value = serde_json::from_slice(
            &self
                .run(&["stats", id, "--mode", "restore-size", "--json"], None)
                .await?,
        )
        .map_err(|_| "復元サイズを確認できません")?;
        require_space(
            &self.work,
            size["total_size"].as_u64().ok_or("復元サイズが不明です")?,
        )?;
        let temp = Temp::new(&self.work)?;
        self.run(
            &[
                "restore",
                id,
                "--target",
                temp.path.to_str().ok_or("Invalid path")?,
                "--verify",
            ],
            None,
        )
        .await?;
        verify_bundle(&temp.path)?;
        Ok(temp)
    }
    pub async fn upload(&self, bundle: &Path, status_root: Option<&Path>) -> Result<Snapshot> {
        self.check_destination().await?;
        let m = verify_bundle(bundle)?;
        let series_tag = format!("series:{}", m.series);
        let dest_tag = format!("destination:{}", self.config.destination);
        let run_tag = format!("run:{}", uuid::Uuid::new_v4());
        let output = self
            .run(
                &[
                    "backup",
                    ".",
                    "--json",
                    "--host",
                    "manga-mac",
                    "--tag",
                    OWNER,
                    "--tag",
                    &series_tag,
                    "--tag",
                    &dest_tag,
                    "--tag",
                    &run_tag,
                ],
                Some(bundle),
            )
            .await?;
        let summary = output
            .split(|b| *b == b'\n')
            .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
            .find(|v| v["message_type"] == "summary")
            .ok_or("保存結果が不明です。旧版は削除しません")?;
        let id = summary["snapshot_id"]
            .as_str()
            .ok_or("snapshot IDが不明です")?;
        if let Some(root) = status_root {
            let mut s = status(root)?;
            s.phase = "verifying".into();
            save_status(root, &s)?;
        }
        let fetched = self.fetch(id).await?;
        let remote = verify_bundle(&fetched.path)?;
        if remote.files != m.files || remote.series != m.series {
            return Err("クラウドからの全量復元検証に失敗しました".into());
        }
        let completed = now()?;
        let verified_tag = format!("verified:{completed}");
        self.run(&["tag", "--add", &verified_tag, id], None).await?;
        // tag changes the snapshot ID. Locate it by unique run tag, not an old ID or hostname.
        let snapshots = self.snapshots().await?;
        snapshots
            .into_iter()
            .find(|s| s.run == run_tag)
            .ok_or("検証済みsnapshotを確認できません".into())
    }
    pub async fn cleanup(&self, at: u64, status_root: Option<&Path>) -> Result<Vec<String>> {
        let progress = |phase: &str| -> Result<()> {
            if let Some(root) = status_root {
                let mut s = status(root)?;
                s.cleanup = phase.into();
                save_status(root, &s)?;
            }
            Ok(())
        };
        progress("repository全量検査中")?;
        self.run(&["check", "--read-data"], None).await?;
        let before = self.snapshots().await?;
        let candidates = expired(&before, at)?;
        if before.is_empty() {
            return Err("保護できる検証済み最新版がありません。整理しません".into());
        }
        // Fully restore every protected latest before any deletion, including inactive works.
        let mut latest: BTreeMap<&str, &Snapshot> = BTreeMap::new();
        for s in &before {
            if latest
                .get(s.series.as_str())
                .is_none_or(|old| (s.completed_at, &s.id) > (old.completed_at, &old.id))
            {
                latest.insert(&s.series, s);
            }
        }
        for s in latest.values() {
            let restored = self.fetch(&s.id).await?;
            if verify_bundle(&restored.path)?.series != s.series {
                return Err("保護対象の作品IDが一致しません".into());
            }
        }
        let after = self.snapshots().await?;
        if after != before {
            return Err("整理中に履歴が変わりました。次回再確認します".into());
        }
        if !candidates.is_empty() {
            progress(&format!("削除候補の事前検査：{}", candidates.join(",")))?;
            let mut args = vec!["forget", "--dry-run"];
            args.extend(candidates.iter().map(String::as_str));
            self.run(&args, None).await?;
            if self.snapshots().await? != before {
                return Err("削除直前に履歴が変わりました".into());
            }
            args.remove(1);
            self.run(&args, None).await?;
            progress("旧snapshot削除完了・容量回収は未完了")?;
        }
        progress("未参照データを回収中（prune）")?;
        self.run(&["prune"], None).await?;
        progress("容量回収完了・repositoryを再検査中")?;
        self.run(&["check"], None).await?;
        Ok(candidates)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub id: String,
    pub series: String,
    pub completed_at: u64,
    pub run: String,
}
impl Snapshot {
    fn parse(value: &Value, destination: &str) -> Option<Self> {
        let tags = value["tags"].as_array()?;
        if tags.len() != 5
            || !tags.contains(&json!(OWNER))
            || !tags.contains(&json!(format!("destination:{destination}")))
        {
            return None;
        }
        let find = |prefix: &str| {
            tags.iter()
                .filter_map(Value::as_str)
                .find_map(|s| s.strip_prefix(prefix))
        };
        let id = value["id"].as_str()?;
        let series = find("series:")?;
        let run = find("run:")?;
        if !valid_hash(id) || !uuid(series) || !uuid(run) {
            return None;
        }
        Some(Self {
            id: id.into(),
            series: series.into(),
            completed_at: find("verified:")?.parse().ok()?,
            run: format!("run:{run}"),
        })
    }
}
pub fn expired(snapshots: &[Snapshot], at: u64) -> Result<Vec<String>> {
    if snapshots.iter().any(|s| s.completed_at > at) {
        return Err("時計がバックアップ完了時刻より過去です。整理を停止しました".into());
    }
    let mut latest: BTreeMap<&str, &Snapshot> = BTreeMap::new();
    for s in snapshots {
        if latest
            .get(s.series.as_str())
            .is_none_or(|old| (s.completed_at, &s.id) > (old.completed_at, &old.id))
        {
            latest.insert(&s.series, s);
        }
    }
    let mut ids: Vec<String> = snapshots
        .iter()
        .filter(|s| {
            latest
                .get(s.series.as_str())
                .is_some_and(|keep| keep.id != s.id)
                && at - s.completed_at >= RETENTION
        })
        .map(|s| s.id.clone())
        .collect();
    ids.sort();
    Ok(ids)
}
pub struct Temp {
    pub path: PathBuf,
}
impl Temp {
    pub fn new(parent: &Path) -> Result<Self> {
        directory(parent)?;
        let path = parent.join(format!("work-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(err)?;
        }
        Ok(Self { path })
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_expiry_latest_ties_multiple_series_and_future_clock() {
        let snapshots = vec![
            Snapshot {
                id: "a".into(),
                series: "one".into(),
                completed_at: 100,
                run: "".into(),
            },
            Snapshot {
                id: "b".into(),
                series: "one".into(),
                completed_at: 200,
                run: "".into(),
            },
            Snapshot {
                id: "c".into(),
                series: "two".into(),
                completed_at: 10,
                run: "".into(),
            },
        ];
        assert!(expired(&snapshots, RETENTION + 99).unwrap().is_empty());
        assert_eq!(expired(&snapshots, RETENTION + 100).unwrap(), vec!["a"]);
        assert_eq!(expired(&snapshots, RETENTION * 10).unwrap(), vec!["a"]);
        assert!(expired(&snapshots, 199).is_err());
        let mut same = snapshots.clone();
        same[1].completed_at = 100;
        assert_eq!(expired(&same, RETENTION * 10).unwrap(), vec!["a"]);
    }
    #[test]
    fn unmanaged_and_unverified_snapshots_cannot_be_deleted() {
        let value = json!({"id":"a".repeat(64),"tags":[OWNER,"series:bad","verified:1"]});
        assert!(Snapshot::parse(&value, "dest").is_none());
        for path in [
            "rclone:drive:",
            "rclone:drive:manga-mac-backups/../personal",
            "rclone::manga-mac-backups/a",
            "rclone:drive:personal",
        ] {
            assert!(validate_repository(path).is_err());
        }
        assert!(validate_repository("rclone:drive:manga-mac-backups/works").is_ok());
    }
    #[tokio::test]
    #[ignore = "requires the checksum-verified RESTIC_TEST_BIN; CI runs explicitly"]
    async fn real_restic_local_roundtrip_and_retention() {
        let binary = std::env::var("RESTIC_TEST_BIN").expect("RESTIC_TEST_BIN is required");
        let (mut db, root) = super::super::super::tests::setup();
        let p = super::super::super::tests::fixture();
        super::super::super::save(&mut db, &root, &p.to_string()).unwrap();
        let work = Temp::new(&root).unwrap();
        let bundle = work.path.join("payload");
        let id = series(&root).unwrap();
        prepare(&db, &root, &bundle, &id, 100).unwrap();
        let config = Config {
            repository: work.path.join("repo").to_str().unwrap().into(),
            restic: binary.into(),
            restic_hash: String::new(),
            rclone: PathBuf::new(),
            rclone_hash: String::new(),
            rclone_config: PathBuf::new(),
            destination: String::new(),
            enabled: false,
        };
        let mut client = Client::new(config, b"test-only-password".to_vec(), work.path.clone());
        client.run(&["init"], None).await.unwrap();
        client.config.destination = client.destination().await.unwrap();
        let first = client.upload(&bundle, None).await.unwrap();
        let second = client.upload(&bundle, None).await.unwrap();
        assert_ne!(first.id, second.id);
        let snapshots = client.snapshots().await.unwrap();
        let latest = snapshots
            .iter()
            .max_by_key(|s| (s.completed_at, s.id.clone()))
            .unwrap()
            .id
            .clone();
        let deleted = client
            .cleanup(now().unwrap() + RETENTION + 1, None)
            .await
            .unwrap();
        assert_eq!(deleted.len(), 1);
        assert_ne!(deleted[0], latest);
        assert_eq!(client.snapshots().await.unwrap().len(), 1);
        let fetched = client.fetch(&latest).await.unwrap();
        assert_eq!(verify_bundle(&fetched.path).unwrap().series, id);
        drop(fetched);
        drop(client);
        drop(work);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "requires checksum-verified RESTIC_TEST_BIN and RCLONE_TEST_BIN"]
    async fn real_restic_rclone_pipe_and_unknown_snapshot_protection() {
        let binary = std::env::var("RESTIC_TEST_BIN").expect("RESTIC_TEST_BIN is required");
        let rclone = std::env::var("RCLONE_TEST_BIN").expect("RCLONE_TEST_BIN is required");
        let (mut db, root) = super::super::super::tests::setup();
        super::super::super::save(
            &mut db,
            &root,
            &super::super::super::tests::fixture().to_string(),
        )
        .unwrap();
        let work = Temp::new(&root).unwrap();
        let bundle = work.path.join("payload");
        let series = series(&root).unwrap();
        prepare(&db, &root, &bundle, &series, 100).unwrap();
        let conf = work.path.join("rclone.conf");
        fs::write(&conf, "[fixture]\ntype = local\n").unwrap();
        let c = Config {
            repository: format!("rclone:fixture:{}", work.path.join("repository").display()),
            restic: binary.into(),
            restic_hash: String::new(),
            rclone: rclone.into(),
            rclone_hash: String::new(),
            rclone_config: conf,
            destination: String::new(),
            enabled: false,
        };
        let mut client = Client::new(c, b"fixture-only-secret".to_vec(), work.path.clone());
        client.run(&["init"], None).await.unwrap();
        client.config.destination = client.destination().await.unwrap();
        let valid = client.upload(&bundle, None).await.unwrap();
        // A foreign/unfinished snapshot remains even when all completed snapshots are older than 21 days.
        client
            .run(
                &["backup", ".", "--tag", "foreign-unverified"],
                Some(&bundle),
            )
            .await
            .unwrap();
        assert!(client
            .cleanup(now().unwrap() + RETENTION + 1, None)
            .await
            .unwrap()
            .is_empty());
        let all: Vec<Value> =
            serde_json::from_slice(&client.run(&["snapshots", "--json"], None).await.unwrap())
                .unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(client.snapshots().await.unwrap().len(), 1);
        let fetched = client.fetch(&valid.id).await.unwrap();
        assert_eq!(verify_bundle(&fetched.path).unwrap().series, series);
        fs::write(bundle.join("manga.sqlite3"), b"damaged").unwrap();
        assert!(client.upload(&bundle, None).await.is_err());
        assert_eq!(client.snapshots().await.unwrap()[0].id, valid.id);
        drop(fetched);
        drop(client);
        drop(work);
        fs::remove_dir_all(root).unwrap();
    }
}
