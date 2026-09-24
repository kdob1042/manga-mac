//! Direct OpenAI Images API. No setup probes, queue broker or automatic retry.
use crate::{media, media_connections::Connection, policy_transport::PolicyTransport};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

const MAX_RESPONSE: usize = 34 * 1024 * 1024;
fn failure() -> String {
    "OpenAI画像生成の結果を取得できません。自動再送しません".into()
}

pub fn payload(input: &Value) -> Result<Value, String> {
    let registry = media::public_registry()?;
    let selected = registry["images"]
        .as_array()
        .ok_or_else(failure)?
        .iter()
        .find(|m| m["id"] == input["media"]["registry_id"] && m["adapter_id"] == "openai-image")
        .ok_or_else(failure)?;
    if input["media"]["model_id"] != selected["model_id"] {
        return Err(failure());
    }
    let width = input["width"].as_u64().ok_or_else(failure)?;
    let height = input["height"].as_u64().ok_or_else(failure)?;
    let bounds = &selected["input"];
    if width < bounds["min_width"].as_u64().ok_or_else(failure)?
        || width > bounds["max_width"].as_u64().ok_or_else(failure)?
        || height < bounds["min_height"].as_u64().ok_or_else(failure)?
        || height > bounds["max_height"].as_u64().ok_or_else(failure)?
        || width % 16 != 0
        || height % 16 != 0
    {
        return Err("OpenAI画像の寸法が未対応です".into());
    }
    let mut prompt = input["prompt"].as_str().ok_or_else(failure)?.to_owned();
    let mut images: Vec<Value> = input["references"]
        .as_array()
        .ok_or_else(failure)?
        .iter()
        .map(|r| json!({"image_url":r["image"]}))
        .collect();
    // Numbered identity references keep their order; the editing/capture source is last.
    if let Some(original) = input["original"].as_str() {
        images.push(json!({"image_url":original}));
        prompt.push_str(&format!(
            "\nImage {} is the source image; preserve its composition unless instructed otherwise.",
            images.len()
        ));
    }
    if prompt.trim().is_empty()
        || prompt.chars().count()
            > bounds["max_prompt_characters"]
                .as_u64()
                .ok_or_else(failure)? as usize
    {
        return Err("OpenAIの作画指示が長すぎるか空です".into());
    }
    if images.len() > bounds["max_references"].as_u64().ok_or_else(failure)? as usize {
        return Err("編集元を含め参照は8枚までです".into());
    }
    let max_bytes = bounds["max_reference_bytes"].as_u64().ok_or_else(failure)? as usize;
    for image in &images {
        let uri = image["image_url"].as_str().ok_or_else(failure)?;
        let (prefix, encoded) = uri.split_once(',').ok_or_else(failure)?;
        if ![
            "data:image/png;base64",
            "data:image/jpeg;base64",
            "data:image/webp;base64",
        ]
        .contains(&prefix)
            || encoded.len() > max_bytes.div_ceil(3) * 4
            || STANDARD.decode(encoded).map_err(|_| failure())?.len() > max_bytes
        {
            return Err("参照画像はPNG/JPEG/WebPの3MB以下にしてください".into());
        }
    }
    let mut body = json!({"model":selected["model_id"],"prompt":prompt,"n":1,
        "size":format!("{width}x{height}"),"quality":selected["request_defaults"]["quality"],
        "output_format":selected["request_defaults"]["output_format"],"background":"opaque"});
    if !images.is_empty() {
        body["images"] = json!(images);
    }
    Ok(body)
}

pub fn endpoint(body: &Value) -> &'static str {
    if body.get("images").is_some() {
        "https://api.openai.com/v1/images/edits"
    } else {
        "https://api.openai.com/v1/images/generations"
    }
}

pub fn decode_result(result: &Value) -> Result<Vec<u8>, String> {
    let data = result["data"]
        .as_array()
        .filter(|a| a.len() == 1)
        .ok_or_else(failure)?;
    let encoded = data[0]["b64_json"]
        .as_str()
        .filter(|s| s.len() <= 32 * 1024 * 1024)
        .ok_or_else(failure)?;
    let bytes = STANDARD.decode(encoded).map_err(|_| failure())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(failure());
    }
    Ok(bytes)
}

// Uncached token rates, rounded up to milli-USD. This is an estimate, not a bill.
pub fn estimated_milli_usd(result: &Value, model: &str) -> Option<u64> {
    let registry = media::public_registry().ok()?;
    let descriptor = registry["images"]
        .as_array()?
        .iter()
        .find(|m| m["model_id"] == model)?;
    let rates = &descriptor["cost"]["usd_per_million_tokens"];
    let usage = &result["usage"];
    let input = &usage["input_tokens_details"];
    let weighted = input["text_tokens"]
        .as_u64()?
        .checked_mul(rates["text_input"].as_u64()?)?
        .checked_add(
            input["image_tokens"]
                .as_u64()?
                .checked_mul(rates["image_input"].as_u64()?)?,
        )?
        .checked_add(
            usage["output_tokens"]
                .as_u64()?
                .checked_mul(rates["output"].as_u64()?)?,
        )?;
    Some(weighted.div_ceil(1000))
}

pub async fn generate(body: &Value, connection: &Connection) -> Result<Value, String> {
    let url = reqwest::Url::parse(endpoint(body)).map_err(|_| failure())?;
    let client = PolicyTransport::external_client(&url).await?;
    let mut response = client
        .post(url)
        .bearer_auth(&connection.credential)
        .json(body)
        .send()
        .await
        .map_err(|_| failure())?;
    if !response.status().is_success() {
        // Provider bodies may echo input or credentials; only expose the status.
        return Err(format!(
            "OpenAI画像API: HTTP {}。自動再送しません",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err(failure());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(failure());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| failure())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"media":{"registry_id":"openai-gpt-image-2-5","model_id":"gpt-image-2.5-sunburst"},"width":1024,"height":1536,"prompt":"scene","references":[]})
    }
    #[test]
    fn generate_and_edit_preserve_numbered_references_without_seed_or_credentials() {
        let mut request = input();
        let generated = payload(&request).unwrap();
        assert!(endpoint(&generated).ends_with("/generations"));
        assert_eq!(generated["size"], "1024x1536");
        assert!(generated.get("seed").is_none());
        request["references"] = json!([{"image":"data:image/png;base64,YQ=="}]);
        request["original"] = json!("data:image/png;base64,Yg==");
        let edited = payload(&request).unwrap();
        assert!(endpoint(&edited).ends_with("/edits"));
        assert_eq!(
            edited["images"][0]["image_url"],
            request["references"][0]["image"]
        );
        assert_eq!(edited["images"][1]["image_url"], request["original"]);
        assert!(edited["prompt"].as_str().unwrap().contains("Image 2"));
        request["references"][0]["image"] = json!("https://unapproved.example/image.png");
        assert!(payload(&request).is_err());
        request = input();
        request["references"] = json!(vec![json!({"image":"data:image/png;base64,YQ=="}); 9]);
        assert!(payload(&request).is_err());
        request = input();
        request["width"] = json!(720);
        assert!(payload(&request).is_err());
    }
    #[test]
    fn only_one_inline_png_is_accepted_and_cost_uses_usage() {
        let result = json!({"data":[{"b64_json":STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture")}],"usage":{"input_tokens_details":{"text_tokens":100,"image_tokens":200},"output_tokens":1000}});
        assert!(decode_result(&result).is_ok());
        assert_eq!(
            estimated_milli_usd(&result, "gpt-image-2.5-sunburst"),
            Some(33)
        );
        assert!(
            decode_result(&json!({"data":[{"url":"https://elsewhere.example/image"}]})).is_err()
        );
        assert_eq!(
            estimated_milli_usd(&json!({}), "gpt-image-2.5-sunburst"),
            None
        );
    }
}
