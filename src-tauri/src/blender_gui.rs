//! Launch only an application-owned GUI, with private bootstrap credentials.
use crate::blender_live::{self, Live};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};
use tokio::{process::Child, sync::Mutex};

#[derive(Default)]
pub struct Launcher(Mutex<HashMap<String, Owned>>);
struct Owned {
    child: Child,
    identity: Value,
}
fn io(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn key(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))[..24].to_owned()
}
fn directory(path: &Path) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(path).map_err(io)?;
    if std::fs::symlink_metadata(path)
        .map_err(io)?
        .file_type()
        .is_symlink()
    {
        return Err("Workspace directory cannot be a symlink".into());
    }
    std::fs::canonicalize(path).map_err(io)
}
pub fn workspace(documents: &Path, work: &str, scope: &str) -> Result<Value, String> {
    if work.is_empty() || scope.is_empty() || work.len() > 8192 || scope.len() > 1024 {
        return Err("Missing work/shot identity".into());
    }
    let root = directory(&documents.join("Manga Mac").join("3D"))?;
    let work_root = directory(&root.join(key(work)))?;
    let assets = directory(&work_root.join("assets"))?;
    let shots = directory(&work_root.join("work"))?;
    let shot = directory(&shots.join(key(scope)))?;
    let exports = directory(&work_root.join("exports"))?;
    let working = shot.join("working.blend");
    if working
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("Working file cannot be a symlink".into());
    }
    let mut templates = Vec::new();
    for entry in std::fs::read_dir(&assets).map_err(io)? {
        let entry = entry.map_err(io)?;
        if entry.file_type().map_err(io)?.is_file()
            && entry.path().extension().is_some_and(|e| e == "blend")
        {
            templates.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    templates.sort();
    Ok(
        json!({"root":work_root,"assets":assets,"working":working,"exports":exports,"templates":templates}),
    )
}

pub async fn launch(
    launcher: &Launcher,
    live: &Live,
    private_root: &Path,
    documents: &Path,
    input: Value,
) -> Result<Value, String> {
    let work = input["work"].as_str().ok_or("Missing work")?;
    let scope = input["scope"].as_str().ok_or("Missing shot")?;
    let directory_work = input["directory_work"]
        .as_str()
        .ok_or("Missing directory identity")?;
    let paths = workspace(documents, directory_work, scope)?;
    let working = paths["working"].as_str().ok_or("Invalid working path")?;
    let mut processes = launcher.0.lock().await;
    let process_key = working.to_owned();
    if let Some(connection) = live.0.lock().await.as_ref() {
        if connection.work != work || connection.target["file"] != working {
            return Err("別の作業へ接続中です。現在の作業を保存し、接続設定で切断してから開いてください。Blenderは終了しません。".into());
        }
        // Drop the lock before the normal identity check below.
    }
    let connected = live.0.lock().await.is_some();
    if connected {
        return blender_live::command(live, "status", json!({"work":work})).await;
    }
    if let Some(owned) = processes.get_mut(&process_key) {
        if owned.child.try_wait().map_err(io)?.is_none() {
            if owned.identity.is_null() {
                return Err(
                    "前回起動したBlenderの準備を確認してください。二重起動はしません。".into(),
                );
            }
            let mut identity = owned.identity.clone();
            identity["work"] = json!(work);
            return blender_live::command(live, "connect", identity).await;
        }
        processes.remove(&process_key);
    }
    // Never launch a second editor for a still-running GUI after an app restart.
    let pid_path = Path::new(working).parent().unwrap().join("gui.pid");
    if let Ok(pid_text) = std::fs::read_to_string(&pid_path) {
        let pid = pid_text
            .parse::<i32>()
            .map_err(|_| "Invalid GUI lock; inspect the working folder")?;
        if pid <= 0 {
            return Err("Invalid GUI process identity".into());
        }
        #[cfg(unix)]
        if unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err(
                "この作業のBlenderは既に開いています。接続設定から明示的に再接続してください。"
                    .into(),
            );
        }
    }
    let template = input["template"].as_str().unwrap_or("");
    if !template.is_empty()
        && !paths["templates"]
            .as_array()
            .is_some_and(|files| files.iter().any(|p| p == template))
    {
        return Err("素材フォルダ内のblendを選択してください".into());
    }
    let boot = directory(&private_root.join(format!("gui-{}", uuid::Uuid::new_v4())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&boot, std::fs::Permissions::from_mode(0o700)).map_err(io)?;
    }
    let addon = directory(&boot.join("manga_mac_live"))?;
    for (name, content) in [
        (
            "__init__.py",
            include_str!("../../blender/live/__init__.py"),
        ),
        (
            "observation.py",
            include_str!("../../blender/live/observation.py"),
        ),
        (
            "operations.py",
            include_str!("../../blender/live/operations.py"),
        ),
        (
            "candidate.py",
            include_str!("../../blender/live/candidate.py"),
        ),
        (
            "capture_support.py",
            include_str!("../../blender/live/capture_support.py"),
        ),
        (
            "viewport.py",
            include_str!("../../blender/live/viewport.py"),
        ),
        (
            "LICENSE.upstream",
            include_str!("../../blender/live/LICENSE.upstream"),
        ),
        (
            "upstream.json",
            include_str!("../../blender/live/upstream.json"),
        ),
    ] {
        std::fs::write(addon.join(name), content).map_err(io)?;
    }
    std::fs::write(
        boot.join("launch.py"),
        include_str!("../../blender/launch_gui.py"),
    )
    .map_err(io)?;
    let source = if template.is_empty() {
        Value::Null
    } else {
        json!(Path::new(paths["assets"].as_str().unwrap()).join(template))
    };
    std::fs::write(
        boot.join("config.json"),
        json!({"working":working,"assets":paths["assets"],"template":source}).to_string(),
    )
    .map_err(io)?;
    let binary = input["binary"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("/Applications/Blender.app/Contents/MacOS/Blender");
    let child = tokio::process::Command::new(binary)
        .args(["--factory-startup", "--disable-autoexec", "--python"])
        .arg(boot.join("launch.py"))
        .arg("--")
        .arg(boot.join("config.json"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| {
            format!("Blender GUIを起動できません。4.5.13のインストール先を確認してください: {e}")
        })?;
    processes.insert(
        process_key.clone(),
        Owned {
            child,
            identity: Value::Null,
        },
    );
    for _ in 0..450 {
        let owned = processes.get_mut(&process_key).unwrap();
        if owned.child.try_wait().map_err(io)?.is_some() {
            processes.remove(&process_key);
            return Err("Blenderが接続準備前に終了しました".into());
        }
        if let Ok(bytes) = std::fs::read(boot.join("ready.json")) {
            std::fs::remove_file(boot.join("ready.json")).map_err(io)?;
            let mut identity: Value = serde_json::from_slice(&bytes).map_err(io)?;
            if let Some(error) = identity["error"].as_str() {
                return Err(format!(
                    "GUI準備失敗: {error}。開いたBlenderを確認してください"
                ));
            }
            if identity["file"] != working {
                return Err("GUI working file mismatch".into());
            }
            identity["work"] = json!(work);
            owned.identity = identity.clone();
            return blender_live::command(live, "connect", identity).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(
        "GUI起動の待機時間を超えました。開いたBlenderを確認してください。自動で再起動しません。"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_isolated_by_work_and_shot_with_no_original_overwrite() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let a = workspace(&root, "work-a", "../shot-a").unwrap();
        let b = workspace(&root, "work-a", "shot-b").unwrap();
        let c = workspace(&root, "work-b", "../shot-a").unwrap();
        assert_eq!(a["assets"], b["assets"]);
        assert_ne!(a["working"], b["working"]);
        assert_ne!(a["assets"], c["assets"]);
        let source = Path::new(a["assets"].as_str().unwrap()).join("source.blend");
        std::fs::write(&source, b"original").unwrap();
        let again = workspace(&root, "work-a", "../shot-a").unwrap();
        assert_eq!(again["templates"], json!(["source.blend"]));
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert!(!Path::new(a["working"].as_str().unwrap()).exists());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&source, a["working"].as_str().unwrap()).unwrap();
            assert!(workspace(&root, "work-a", "../shot-a").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "requires a real Blender 4.5.13 GUI"]
    async fn gui_auto_start() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let launcher = Launcher::default();
        let live = Live::default();
        let input = json!({"work":"w", "directory_work":"w", "scope":"panel:p", "binary":std::env::var("BLENDER_BIN").unwrap()});
        let identity = launch(&launcher, &live, &root, &root, input.clone())
            .await
            .unwrap();
        assert_eq!(identity["mode"], "live");
        assert!(Path::new(identity["file"].as_str().unwrap()).is_file());
        let same = launch(&launcher, &live, &root, &root, input.clone())
            .await
            .unwrap();
        assert_eq!(identity["instance"], same["instance"]);
        let mut other = input.clone();
        other["scope"] = json!("panel:other");
        assert!(launch(&launcher, &live, &root, &root, other).await.is_err());
        let mut state =
            blender_live::command(&live, "observe", json!({"work":"w","scope":"summary"}))
                .await
                .unwrap();
        let camera = state["camera"].as_str().unwrap().to_owned();
        let detail = blender_live::command(
            &live,
            "observe",
            json!({"work":"w","scope":"object","object":camera}),
        )
        .await
        .unwrap();
        blender_live::command(&live, "resume", json!({"work":"w","expected":state}))
            .await
            .unwrap();
        for operation in [
            json!({"kind":"rotation","object":camera,"object_id":detail["id"],"rotation":[0.2,0.3,0.4]}),
            json!({"kind":"aim","object":camera,"object_id":detail["id"],"target":[0,0,0]}),
        ] {
            state = blender_live::command(&live, "observe", json!({"work":"w","scope":"summary"}))
                .await
                .unwrap();
            let applied = blender_live::command(&live, "act", json!({"work":"w","expected":state,"request_id":uuid::Uuid::new_v4().to_string(),"operation":operation})).await.unwrap();
            assert_eq!(applied["changed"], true);
            let detail = blender_live::command(
                &live,
                "observe",
                json!({"work":"w","scope":"object","object":camera}),
            )
            .await
            .unwrap();
            if operation["kind"] == "rotation" {
                for i in 0..3 {
                    assert!(
                        (detail["rotation"][i].as_f64().unwrap()
                            - operation["rotation"][i].as_f64().unwrap())
                        .abs()
                            < 1e-5
                    );
                }
            } else {
                let rows = detail["evaluated_world"].as_array().unwrap();
                let mut dot = 0.0;
                let mut length = 0.0;
                for row in rows.iter().take(3) {
                    let delta = -row[3].as_f64().unwrap();
                    dot += -row[2].as_f64().unwrap() * delta;
                    length += delta * delta;
                }
                assert!(dot / length.sqrt() > 1.0 - 1e-6);
            }
        }
        blender_live::command(&live, "handoff", json!({"work":"w"}))
            .await
            .unwrap();
        let original_camera = blender_live::command(
            &live,
            "observe",
            json!({"work":"w","scope":"object","object":camera}),
        )
        .await
        .unwrap();
        let mut angle_hashes = Vec::new();
        for degrees in [0, 30] {
            state = blender_live::command(&live, "observe", json!({"work":"w","scope":"summary"}))
                .await
                .unwrap();
            let captured = blender_live::command(&live, "candidate", json!({"work":"w","expected":state,"width":128,"height":128,"angle":{"degrees":degrees,"target":[0,0,0]}})).await.unwrap();
            angle_hashes.push(captured["state"]["image"]["hash"].clone());
            let after = blender_live::command(
                &live,
                "observe",
                json!({"work":"w","scope":"object","object":camera}),
            )
            .await
            .unwrap();
            assert_eq!(after["location"], original_camera["location"]);
            assert_eq!(after["rotation"], original_camera["rotation"]);
            assert_eq!(after["revision"], captured["revision"]);
        }
        assert_ne!(angle_hashes[0], angle_hashes[1]);
        state = blender_live::command(&live, "observe", json!({"work":"w","scope":"summary"}))
            .await
            .unwrap();
        blender_live::command(&live, "save_working", json!({"work":"w","expected":state}))
            .await
            .unwrap();
        blender_live::command(&live, "disconnect", json!({}))
            .await
            .unwrap();
        let reconnected = launch(&launcher, &live, &root, &root, input.clone())
            .await
            .unwrap();
        assert_eq!(identity["instance"], reconnected["instance"]);
        blender_live::command(&live, "disconnect", json!({}))
            .await
            .unwrap();
        // Only this test's child processes may be terminated.
        for owned in launcher.0.lock().await.values_mut() {
            owned.child.kill().await.unwrap();
        }
        let reopened = launch(&launcher, &live, &root, &root, input.clone())
            .await
            .unwrap();
        assert_ne!(identity["instance"], reopened["instance"]);
        let paths = workspace(&root, "w", "panel:p").unwrap();
        let source = Path::new(paths["assets"].as_str().unwrap()).join("template.blend");
        std::fs::copy(identity["file"].as_str().unwrap(), &source).unwrap();
        let original = std::fs::read(&source).unwrap();
        blender_live::command(&live, "disconnect", json!({}))
            .await
            .unwrap();
        let mut from_template = input;
        from_template["scope"] = json!("panel:from-template");
        from_template["template"] = json!("template.blend");
        let copied = launch(&launcher, &live, &root, &root, from_template)
            .await
            .unwrap();
        assert_ne!(copied["file"], reopened["file"]);
        assert!(Path::new(copied["file"].as_str().unwrap()).is_file());
        assert_eq!(std::fs::read(source).unwrap(), original);
        blender_live::command(&live, "disconnect", json!({}))
            .await
            .unwrap();
        for owned in launcher.0.lock().await.values_mut() {
            owned.child.kill().await.unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
