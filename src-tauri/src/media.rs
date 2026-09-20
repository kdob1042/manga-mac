//! Small registry and validation boundary shared by image/video dispatch.
//! Provider-specific wire formats remain in their adapters (Swift and runway).
use serde_json::{json, Value};

const REGISTRY: &str = include_str!("../../src/media-registry.json");

#[derive(Clone)]
pub struct ImageModel {
    pub registry_id: String,
    pub adapter_id: String,
    pub model_id: String,
    pub min_width: u64,
    pub max_width: u64,
    pub min_height: u64,
    pub max_height: u64,
    pub step: u64,
    pub max_aspect_ratio: f64,
    pub steps: u64,
}

#[derive(Clone)]
pub struct VideoModel {
    pub registry_id: String,
    pub adapter_id: String,
    pub provider: String,
    pub model_id: String,
    pub locality: String,
    pub end_frame: bool,
}

fn registry() -> Result<Value, String> {
    serde_json::from_str(REGISTRY).map_err(|_| "メディアモデル定義が不正です".into())
}

pub fn public_registry() -> Result<Value, String> {
    registry()
}

fn descriptor(kind: &str, id: &str) -> Result<Value, String> {
    let data = registry()?;
    data[kind]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"].as_str() == Some(id)))
        .cloned()
        .ok_or_else(|| "登録済みのメディアモデルではありません".into())
}

fn implemented(value: &Value) -> Result<(), String> {
    if value["status"].as_str() == Some("implemented") {
        Ok(())
    } else {
        Err("このメディア接続はまだ実装されていません".into())
    }
}

pub fn image_model(id: Option<&str>) -> Result<ImageModel, String> {
    let data = registry()?;
    let selected_id = id
        .map(str::to_owned)
        .or_else(|| data["defaults"]["image"].as_str().map(str::to_owned))
        .ok_or("画像モデルの既定値がありません")?;
    let value = descriptor("images", &selected_id)?;
    implemented(&value)?;
    let input = &value["input"];
    Ok(ImageModel {
        registry_id: selected_id,
        adapter_id: value["adapter_id"].as_str().ok_or("画像adapter定義が不正です")?.into(),
        model_id: value["model_id"].as_str().ok_or("画像model定義が不正です")?.into(),
        min_width: input["min_width"].as_u64().ok_or("画像寸法定義が不正です")?,
        max_width: input["max_width"].as_u64().ok_or("画像寸法定義が不正です")?,
        min_height: input["min_height"].as_u64().ok_or("画像寸法定義が不正です")?,
        max_height: input["max_height"].as_u64().ok_or("画像寸法定義が不正です")?,
        step: input["step"].as_u64().ok_or("画像寸法定義が不正です")?,
        max_aspect_ratio: input["max_aspect_ratio"].as_f64().ok_or("画像比率定義が不正です")?,
        steps: input["steps"].as_u64().ok_or("画像step定義が不正です")?,
    })
}

pub fn validate_image_request(request: &Value) -> Result<ImageModel, String> {
    let media = request.get("media").cloned().unwrap_or_else(|| json!({}));
    let media_object = media.as_object().ok_or("画像の実行先定義が不正です")?;
    if media_object
        .keys()
        .any(|key| !matches!(key.as_str(), "registry_id" | "adapter_id" | "model_id"))
        || request.get("endpoint").is_some()
        || request.get("provider").is_some()
    {
        return Err("画像の実行先に任意の接続先を指定できません".into());
    }
    let selected = image_model(media["registry_id"].as_str())?;
    if (media.get("adapter_id").is_some()
        && media["adapter_id"].as_str() != Some(selected.adapter_id.as_str()))
        || (media.get("model_id").is_some()
            && media["model_id"].as_str() != Some(selected.model_id.as_str()))
    {
        return Err("画像の実行先定義が登録情報と一致しません".into());
    }
    if selected.adapter_id != "media-generation-kit" {
        return Err("選択した画像adapterはまだ接続されていません".into());
    }
    let width = request["width"].as_u64().ok_or("画像幅がありません")?;
    let height = request["height"].as_u64().ok_or("画像高さがありません")?;
    if width < selected.min_width
        || width > selected.max_width
        || height < selected.min_height
        || height > selected.max_height
        || width % selected.step != 0
        || height % selected.step != 0
        || (width as f64) / (height as f64) > selected.max_aspect_ratio
        || (height as f64) / (width as f64) > selected.max_aspect_ratio
    {
        return Err("画像モデルが対応しない縦横・寸法です".into());
    }
    let operation = match request["recovery"]["kind"].as_str() {
        Some("edit") => "edit",
        Some("retake") if request["recovery"]["panel"]["finishing"].is_object() => "finishing",
        Some("retake") => "retake",
        Some("generate") => "generate",
        _ => return Err("画像生成操作が不正です".into()),
    };
    let descriptor = descriptor("images", &selected.registry_id)?;
    if !descriptor["operations"].as_array().is_some_and(|items| {
        items.iter().any(|item| item.as_str() == Some(operation))
    }) {
        return Err("選択した画像モデルはこの操作に対応していません".into());
    }
    Ok(selected)
}

pub fn video_model_from_connection(connection: &Value) -> Result<VideoModel, String> {
    let connection_object = connection.as_object().ok_or("動画接続定義が不正です")?;
    if connection_object
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "provider" | "model" | "adapter_id"))
    {
        return Err("動画接続に任意の接続先を指定できません".into());
    }
    let provider = connection["provider"].as_str().ok_or("動画providerがありません")?;
    let model_id = connection["model"].as_str().ok_or("動画modelがありません")?;
    let data = registry()?;
    let value = data["videos"]
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item["provider"].as_str() == Some(provider)
                    && item["model_id"].as_str() == Some(model_id)
            })
        })
        .cloned()
        .ok_or_else(|| "登録済みの動画モデルではありません".to_string())?;
    implemented(&value)?;
    if connection.get("adapter_id").is_some()
        && connection["adapter_id"].as_str() != value["adapter_id"].as_str()
    {
        return Err("動画のadapter定義が登録情報と一致しません".into());
    }
    let capabilities = &value["capabilities"];
    Ok(VideoModel {
        registry_id: value["id"].as_str().ok_or("動画model定義が不正です")?.into(),
        adapter_id: value["adapter_id"].as_str().ok_or("動画adapter定義が不正です")?.into(),
        provider: provider.into(),
        model_id: model_id.into(),
        locality: value["locality"].as_str().ok_or("動画接続の場所定義が不正です")?.into(),
        end_frame: capabilities["end_frame"].as_bool().unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_image_request_is_registry_bound() {
        let model = image_model(None).expect("default image model");
        let request = json!({
            "width": 768,
            "height": 768,
            "media": {
                "registry_id": model.registry_id.clone(),
                "adapter_id": model.adapter_id.clone(),
                "model_id": model.model_id.clone()
            },
            "recovery": {"kind": "generate", "panel": {}}
        });
        assert_eq!(validate_image_request(&request).expect("valid request").steps, 4);
    }

    #[test]
    fn invented_image_model_and_video_adapter_are_rejected() {
        let image = json!({
            "width": 768,
            "height": 768,
            "media": {"registry_id": "qwen-image", "adapter_id": "qwen", "model_id": "qwen"},
            "recovery": {"kind": "generate", "panel": {}}
        });
        assert!(validate_image_request(&image).is_err());
        assert!(video_model_from_connection(&json!({
            "provider": "runway",
            "model": "invented",
            "adapter_id": "runway"
        }))
        .is_err());
    }
}
