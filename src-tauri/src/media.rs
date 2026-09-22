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
    pub output_kind: String,
}

#[derive(Clone)]
pub struct VideoModel {
    pub locality: String,
    pub adapter_id: String,
    pub provider: String,
    pub model_id: String,
    pub request_profile: String,
    pub durations_sec: Vec<u64>,
    pub ratios: Vec<String>,
    pub end_frame: bool,
    pub max_prompt_utf16: u64,
    pub min_aspect_ratio: f64,
    pub max_aspect_ratio: f64,
    pub output_tiers: Value,
    pub pricing: Value,
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
        adapter_id: value["adapter_id"]
            .as_str()
            .ok_or("画像adapter定義が不正です")?
            .into(),
        model_id: value["model_id"]
            .as_str()
            .ok_or("画像model定義が不正です")?
            .into(),
        min_width: input["min_width"]
            .as_u64()
            .ok_or("画像寸法定義が不正です")?,
        max_width: input["max_width"]
            .as_u64()
            .ok_or("画像寸法定義が不正です")?,
        min_height: input["min_height"]
            .as_u64()
            .ok_or("画像寸法定義が不正です")?,
        max_height: input["max_height"]
            .as_u64()
            .ok_or("画像寸法定義が不正です")?,
        step: input["step"].as_u64().ok_or("画像寸法定義が不正です")?,
        max_aspect_ratio: input["max_aspect_ratio"]
            .as_f64()
            .ok_or("画像比率定義が不正です")?,
        steps: input["steps"].as_u64().ok_or("画像step定義が不正です")?,
        output_kind: value["output"]["kind"].as_str().unwrap_or("image").into(),
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
    if !["media-generation-kit", "runway-image"].contains(&selected.adapter_id.as_str()) {
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
        Some("edit" | "layer_edit") => "edit",
        Some("retake") if request["recovery"]["panel"]["finishing"].is_object() => "finishing",
        Some("retake") => "retake",
        Some("generate") => "generate",
        Some("decompose") => "decompose",
        _ => return Err("画像生成操作が不正です".into()),
    };
    let descriptor = descriptor("images", &selected.registry_id)?;
    if selected.output_kind == "ordered-rgba-layers" {
        if request["recovery"]["layered"]["runtime"] != descriptor["runtime"]
            || request["recovery"]["layered"]["output"] != descriptor["output"]
        {
            return Err("レイヤー実行版・出力条件が登録情報と一致しません".into());
        }
        let count = request["layer_count"]
            .as_u64()
            .ok_or("レイヤー数がありません")?;
        if operation != "decompose"
            || request["original"].as_str().is_none()
            || count < descriptor["input"]["min_layers"].as_u64().unwrap_or(2)
            || count > descriptor["input"]["max_layers"].as_u64().unwrap_or(6)
        {
            return Err("レイヤー分解の入力・枚数が不正です".into());
        }
    }
    if request["recovery"]["kind"] == "layer_edit"
        && request["recovery"]["layer_edit"]["runtime"] != descriptor["runtime"]
    {
        return Err("レイヤー編集の実行版が登録情報と一致しません".into());
    }
    let references = request["references"]
        .as_array()
        .ok_or("参照画像一覧がありません")?;
    let maximum = descriptor["input"]["max_references"].as_u64().unwrap_or(0);
    if references.len() as u64 > maximum {
        return Err("参照画像の枚数がモデルの上限を超えています".into());
    }

    if !descriptor["operations"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(operation)))
    {
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
    let provider = connection["provider"]
        .as_str()
        .ok_or("動画providerがありません")?;
    let model_id = connection["model"]
        .as_str()
        .ok_or("動画modelがありません")?;
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
    let input = &value["input"];
    let durations_sec = input["durations_sec"]
        .as_array()
        .ok_or("動画尺定義が不正です")?
        .iter()
        .map(|item| {
            item.as_u64()
                .ok_or_else(|| "動画尺定義が不正です".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let ratios = input["ratios"]
        .as_array()
        .ok_or("動画寸法定義が不正です")?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "動画寸法定義が不正です".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if durations_sec.is_empty() || ratios.is_empty() {
        return Err("動画モデルの入力定義が空です".into());
    }
    let request_profile = value["request_profile"]
        .as_str()
        .ok_or("動画request profile定義が不正です")?
        .to_owned();
    let max_prompt_utf16 = input["max_prompt_utf16"]
        .as_u64()
        .ok_or("動画prompt上限定義が不正です")?;
    let min_aspect_ratio = input["min_aspect_ratio"]
        .as_f64()
        .ok_or("動画入力比率定義が不正です")?;
    let max_aspect_ratio = input["max_aspect_ratio"]
        .as_f64()
        .ok_or("動画入力比率定義が不正です")?;
    if max_prompt_utf16 == 0
        || !min_aspect_ratio.is_finite()
        || !max_aspect_ratio.is_finite()
        || min_aspect_ratio <= 0.0
        || max_aspect_ratio < min_aspect_ratio
    {
        return Err("動画モデル定義が不正です".into());
    }
    Ok(VideoModel {
        locality: value["locality"]
            .as_str()
            .ok_or("動画実行先の定義が不正です")?
            .into(),
        adapter_id: value["adapter_id"]
            .as_str()
            .ok_or("動画adapter定義が不正です")?
            .into(),
        provider: provider.into(),
        model_id: model_id.into(),
        request_profile,
        durations_sec,
        ratios,
        end_frame: value["capabilities"]["end_frame"]
            .as_bool()
            .unwrap_or(false),
        max_prompt_utf16,
        min_aspect_ratio,
        max_aspect_ratio,
        output_tiers: value["output_tiers"].clone(),
        pricing: value["pricing"].clone(),
    })
}

pub fn video_pricing(model: &VideoModel, duration: u64, ratio: &str) -> Result<Value, String> {
    if !model.durations_sec.contains(&duration)
        || !model.ratios.iter().any(|supported| supported == ratio)
    {
        return Err("選択した動画モデルが尺・寸法に対応していません".into());
    }
    let pricing = pricing_object(&model.pricing)?;
    let minimum = pricing
        .get("minimum_credits")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let (tier, rate) = if let Some(rate) = pricing.get("credits_per_second").and_then(Value::as_u64)
    {
        ("default".to_string(), rate)
    } else {
        let tiers = model
            .output_tiers
            .as_object()
            .ok_or("動画料金tier定義が不正です")?;
        let tier = tiers
            .iter()
            .find(|(_, ratios)| {
                ratios
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(ratio)))
            })
            .map(|(name, _)| name.clone())
            .ok_or("動画料金tierを確認できません")?;
        let rate = pricing
            .get("credits_per_second_by_tier")
            .and_then(Value::as_object)
            .and_then(|rates| rates.get(&tier))
            .and_then(Value::as_u64)
            .ok_or("動画料金定義が不正です")?;
        (tier, rate)
    };
    if rate == 0 && model.locality != "local" {
        return Err("動画料金定義が不正です".into());
    }
    let calculated = rate.checked_mul(duration).ok_or("Invalid cost")?;
    let estimated = calculated.max(minimum);
    Ok(json!({
        "credits": estimated,
        "rate": rate,
        "minimum": minimum,
        "tier": tier,
        "checked_at": pricing.get("checked_at").cloned().unwrap_or(Value::Null)
    }))
}

fn pricing_object(value: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    value.as_object().ok_or("動画料金定義が不正です".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_image_request_is_registry_bound() {
        let model = image_model(None).expect("default image model");
        let request = json!({
            "references": [],
            "width": 768,
            "height": 768,
            "media": {
                "registry_id": model.registry_id.clone(),
                "adapter_id": model.adapter_id.clone(),
                "model_id": model.model_id.clone()
            },
            "recovery": {"kind": "generate", "panel": {}}
        });
        assert_eq!(
            validate_image_request(&request)
                .expect("valid request")
                .steps,
            4
        );
    }

    #[test]
    fn layered_model_does_not_accept_moodboards_or_rgb_generation() {
        let mut request = json!({"media":{"registry_id":"qwen-image-layered-q6-local"},
            "width":640,"height":640,"layer_count":4,"original":"fixture","references":[],
            "recovery":{"kind":"decompose"}});
        let definition = descriptor("images", "qwen-image-layered-q6-local").unwrap();
        request["recovery"]["layered"] =
            json!({"runtime":definition["runtime"],"output":definition["output"]});
        assert_eq!(
            validate_image_request(&request).unwrap().output_kind,
            "ordered-rgba-layers"
        );
        request["references"] = json!([{}]);
        assert!(validate_image_request(&request).is_err());
        request["references"] = json!([]);
        request["recovery"]["kind"] = json!("generate");
        assert!(validate_image_request(&request).is_err());
    }
    #[test]
    fn seedance_pricing_and_contract_are_registry_bound() {
        let model = video_model_from_connection(&json!({
            "provider":"runway",
            "model":"seedance2_5",
            "adapter_id":"runway"
        }))
        .unwrap();
        assert_eq!(model.request_profile, "seedance-keyframes-v1");
        assert!(model.end_frame);
        assert_eq!(model.max_prompt_utf16, 15000);
        assert_eq!(video_pricing(&model, 4, "854:480").unwrap()["credits"], 80);
        assert_eq!(
            video_pricing(&model, 5, "1280:720").unwrap()["credits"],
            150
        );
        assert_eq!(
            video_pricing(&model, 5, "1920:1080").unwrap()["credits"],
            340
        );
        assert!(video_pricing(&model, 3, "1280:720").is_err());
        assert!(video_pricing(&model, 5, "1000:1000").is_err());
    }

    #[test]
    fn invented_image_model_and_video_adapter_are_rejected() {
        let image = json!({
            "references": [],
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
