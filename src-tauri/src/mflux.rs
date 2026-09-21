use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

fn err(e: impl std::fmt::Display) -> String { e.to_string() }

fn executable(name: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOMEがありません")?;
    let path = PathBuf::from(home).join(".local/bin").join(name);
    if path.is_file() { Ok(path) } else { Err(format!("MFLUXが未導入です。uv tool install --upgrade mflux を実行してください（{name} がありません）")) }
}

fn write_data_uri(uri: &str, path: &Path) -> Result<(), String> {
    let (_, encoded) = uri.split_once(',').ok_or("画像データが不正です")?;
    let bytes = STANDARD.decode(encoded).map_err(err)?;
    std::fs::write(path, bytes).map_err(err)
}

async fn run(mut command: tokio::process::Command) -> Result<String, String> {
    command.env_clear();
    for name in ["HOME", "TMPDIR", "PATH", "LANG", "HF_HOME", "HF_TOKEN"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    command.kill_on_drop(true).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = tokio::time::timeout(Duration::from_secs(3600), command.output())
        .await.map_err(|_| "MFLUX画像生成が制限時間を超えました")?.map_err(err)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(4000).collect());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub async fn prepare(model_id: &str) -> Result<String, String> {
    if model_id != "flux2-klein-4b" { return Err("未登録のMFLUXモデルです".into()); }
    let _ = executable("mflux-generate-flux2")?;
    let _ = executable("mflux-generate-flux2-edit")?;
    Ok("ready".into())
}

pub async fn generate(request: &Value, model_id: &str, steps: u64) -> Result<String, String> {
    if model_id != "flux2-klein-4b" || steps != 4 { return Err("MFLUXモデル設定が不正です".into()); }
    let temp = std::env::temp_dir().join(format!("manga-mflux-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&temp).map_err(err)?;
    let result = async {
        let original = request["original"].as_str();
        let refs = request["references"].as_array().ok_or("参照画像定義がありません")?;
        let edit = original.is_some() || !refs.is_empty();
        let exe = executable(if edit { "mflux-generate-flux2-edit" } else { "mflux-generate-flux2" })?;
        let output = temp.join("result.png");
        let mut command = tokio::process::Command::new(exe);
        let seed = request["seed"].as_u64().ok_or("seedがありません")?.to_string();
        let width = request["width"].as_u64().ok_or("画像幅がありません")?.to_string();
        let height = request["height"].as_u64().ok_or("画像高さがありません")?.to_string();
        command
            .arg("--model").arg(model_id)
            .arg("--prompt").arg(request["prompt"].as_str().ok_or("promptがありません")?)
            .arg("--steps").arg("4")
            .arg("--quantize").arg("8")
            .arg("--seed").arg(seed)
            .arg("--width").arg(width)
            .arg("--height").arg(height)
            .arg("--output").arg(&output);
        if edit {
            let mut paths = Vec::new();
            if let Some(uri) = original {
                let path = temp.join("original.png");
                write_data_uri(uri, &path)?;
                paths.push(path);
            }
            for (i, reference) in refs.iter().enumerate() {
                let path = temp.join(format!("ref-{i}.png"));
                write_data_uri(reference["image"].as_str().ok_or("参照画像がありません")?, &path)?;
                paths.push(path);
            }
            command.arg("--image-paths");
            for path in &paths { command.arg(path); }
        }
        run(command).await?;
        let bytes = std::fs::read(&output).map_err(|_| "MFLUX出力画像がありません")?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("MFLUX出力がPNGではありません".into()); }
        let destination = PathBuf::from(request["output"]["directory"].as_str().ok_or("保存先がありません")?);
        let image = destination.join("result.png");
        std::fs::write(&image, &bytes).map_err(err)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let receipt = serde_json::json!({"request_hash": request["output"]["request_hash"], "hash": hash});
        std::fs::write(destination.join("receipt.json"), receipt.to_string()).map_err(err)?;
        Ok::<String, String>("MANGA_RESULT_SAVED".into())
    }.await;
    let _ = std::fs::remove_dir_all(&temp);
    result
}
