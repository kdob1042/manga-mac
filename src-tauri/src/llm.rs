//! Explicit connection registry; rig-core owns the wire protocol.
use crate::policy_transport::PolicyTransport;
use base64::{engine::general_purpose::STANDARD, Engine};
use rig_core::{
    client::CompletionClient,
    completion::{CompletionModel, CompletionResponse, FinishReason},
    message::{AssistantContent, DocumentSourceKind, Image, ImageMediaType, Message, UserContent},
    providers::{anthropic, ollama, openai},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tracing::instrument::WithSubscriber;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    Openai,
    Gemini,
    Anthropic,
    Deepseek,
    Custom,
    Jev,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    Plan,
    Direction,
    Layout,
    Translation,
    Edit,
    Lettering,
    Vision,
    Classify,
    Probe,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub provider: Provider,
    pub purpose: Purpose,
    pub endpoint: String,
    pub model: String,
    pub credential: String,
    pub json_mode: bool,
}
// Deliberately no Debug or Serialize: credentials never enter logs or project JSON.
struct Connection {
    provider: Provider,
    purpose: Purpose,
    endpoint: String,
    model: String,
    credential: String,
    json_mode: bool,
}
impl Connection {
    fn path(&self) -> &str {
        match self.provider {
            Provider::Ollama => "/api/chat",
            Provider::Jev => "/v1/systemone",
            Provider::Anthropic => "/v1/messages",
            _ => "/chat/completions",
        }
    }
}
#[derive(Default)]
pub struct Connections {
    entries: Mutex<HashMap<String, Arc<Connection>>>,
    limits: Mutex<HashMap<String, Arc<tokio::sync::Semaphore>>>,
    submitted: Mutex<HashSet<String>>,
    active: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    cancelled: Mutex<HashSet<String>>,
    video: Mutex<HashMap<String, Arc<VideoConnection>>>,
    tripo: Mutex<HashMap<String, Arc<TripoConnection>>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoRegistration {
    pub credential: String,
    pub max_credits: u64,
    pub approved: bool,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub adapter_id: Option<String>,
}
// Same ephemeral credential owner as LLM connections; no Debug/Serialize.
pub struct VideoConnection {
    pub credential: String,
    pub max_credits: u64,
    pub provider: String,
    pub model: String,
    pub adapter_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TripoRegistration {
    pub credential: String,
    pub max_credits: u64,
    pub approved: bool,
}
// Same ephemeral credential owner as LLM/video connections; never Serialize/Debug.
pub struct TripoConnection {
    pub credential: String,
    pub max_credits: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub connection_id: String,
    pub purpose: Purpose,
    pub request_id: String,
    pub prompt: String,
    pub schema: Value,
    pub images: Vec<String>,
}
#[derive(Serialize)]
pub struct Response {
    pub request_id: String,
    pub value: Value,
}
fn failure() -> String {
    "LLM要求を完了できませんでした。自動再送は行いません".into()
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
impl Connections {
    pub fn is_local(&self, id: &str) -> Result<bool, String> {
        self.entries
            .lock()
            .map_err(|_| failure())?
            .get(id)
            .map(|c| c.provider == Provider::Ollama)
            .ok_or_else(failure)
    }
    pub async fn register_video(
        &self,
        input: VideoRegistration,
        provider: String,
        model: String,
        adapter_id: String,
    ) -> Result<String, String> {
        if !input.approved
            || !(if adapter_id == "runway-image" {5} else {60}..=6000).contains(&input.max_credits)
            || input.credential.trim().is_empty()
            || input.credential.len() > 4096
            || input.credential.chars().any(char::is_control)
        {
            return Err("送信先・モデル・予算を承認し、APIキーを入力してください".into());
        }
        PolicyTransport::new("https://api.dev.runwayml.com", false, "").await?;
        let mut entries = self.video.lock().map_err(|_| failure())?;
        if entries.len() >= 4 {
            return Err("不要な動画接続を解除してください".into());
        }
        let id = id();
        entries.insert(
            id.clone(),
            Arc::new(VideoConnection {
                credential: input.credential,
                max_credits: input.max_credits,
                provider,
                model,
                adapter_id,
            }),
        );
        Ok(id)
    }
    pub fn video_connection(&self, id: &str) -> Result<Arc<VideoConnection>, String> {
        self.video
            .lock()
            .map_err(|_| failure())?
            .get(id)
            .cloned()
            .ok_or("動画接続を登録してください".into())
    }
    pub fn remove_video(&self, id: &str) -> Result<(), String> {
        self.video.lock().map_err(|_| failure())?.remove(id);
        Ok(())
    }
    pub async fn register_tripo(&self, input: TripoRegistration) -> Result<String, String> {
        if !input.approved
            || !(1..=100_000).contains(&input.max_credits)
            || input.credential.trim().is_empty()
            || input.credential.len() > 4096
            || input.credential.chars().any(char::is_control)
            || !input.credential.starts_with("tsk_")
        {
            return Err("Tripoの送信先・モデル・予算を承認し、APIキーを入力してください".into());
        }
        PolicyTransport::new("https://api.tripo3d.ai/v2/openapi", false, "").await?;
        let mut entries = self.tripo.lock().map_err(|_| failure())?;
        if entries.len() >= 4 {
            return Err("不要なTripo接続を解除してください".into());
        }
        let id = id();
        entries.insert(
            id.clone(),
            Arc::new(TripoConnection {
                credential: input.credential,
                max_credits: input.max_credits,
            }),
        );
        Ok(id)
    }
    pub fn tripo_connection(&self, id: &str) -> Result<Arc<TripoConnection>, String> {
        self.tripo
            .lock()
            .map_err(|_| failure())?
            .get(id)
            .cloned()
            .ok_or("Tripo接続を登録してください".into())
    }
    pub fn remove_tripo(&self, id: &str) -> Result<(), String> {
        self.tripo.lock().map_err(|_| failure())?.remove(id);
        Ok(())
    }
    pub async fn register(&self, input: Registration) -> Result<String, String> {
        if input.model.trim().is_empty()
            || input.model.len() > 256
            || input.model.chars().any(char::is_control)
        {
            return Err("モデルIDが不正です".into());
        }
        if input.credential.len() > 4096
            || input.credential.chars().any(char::is_control)
            || (input.provider != Provider::Ollama && input.credential.trim().is_empty())
        {
            return Err("認証情報が不正です".into());
        }
        if (input.provider == Provider::Jev) != (input.purpose == Purpose::Classify) {
            return Err("Jevは操作判断専用の接続です".into());
        }
        let endpoint = match input.provider {
            Provider::Ollama => "http://127.0.0.1:11434",
            Provider::Openai => "https://api.openai.com/v1",
            Provider::Gemini => "https://generativelanguage.googleapis.com/v1beta/openai",
            Provider::Anthropic => "https://api.anthropic.com",
            Provider::Deepseek => "https://api.deepseek.com/v1",
            Provider::Custom => input.endpoint.trim_end_matches('/'),
            Provider::Jev => "https://api.typesafe.ai",
        }
        .to_string();
        // Resolve at registration for feedback and again before every send to prevent DNS rebinding.
        PolicyTransport::new(&endpoint, input.provider == Provider::Ollama, "").await?;
        let connection = Arc::new(Connection {
            provider: input.provider,
            purpose: input.purpose,
            endpoint,
            model: input.model,
            credential: if input.provider == Provider::Ollama {
                String::new()
            } else {
                input.credential
            },
            json_mode: input.json_mode,
        });
        let mut entries = self.entries.lock().map_err(|_| failure())?;
        if entries.len() >= 32 {
            return Err("登録接続の上限です。不要な接続を解除してください".into());
        }
        let id = id();
        entries.insert(id.clone(), connection);
        Ok(id)
    }
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.entries.lock().map_err(|_| failure())?.remove(id);
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(failure());
        }
        {
            let mut cancelled = self.cancelled.lock().map_err(|_| failure())?;
            if cancelled.len() < 4096 {
                cancelled.insert(id.to_string());
            }
        }
        if let Some(sender) = self.active.lock().map_err(|_| failure())?.remove(id) {
            let _ = sender.send(());
        }
        let mut submitted = self.submitted.lock().map_err(|_| failure())?;
        if submitted.len() < 4096 {
            submitted.insert(id.to_string());
        }
        Ok(())
    }
    pub async fn request(&self, request: Request) -> Result<Response, String> {
        if uuid::Uuid::parse_str(&request.request_id).is_err()
            || request.prompt.len() > 1024 * 1024
            || request.images.len() > 8
            || !request.schema.is_object()
            || request.schema.to_string().len() > 65536
        {
            return Err("LLM要求が上限または形式に適合しません".into());
        }
        if request.purpose == Purpose::Vision && request.images.is_empty() {
            return Err("対象認識には画像が必要です".into());
        }
        let connection = self
            .entries
            .lock()
            .map_err(|_| failure())?
            .get(&request.connection_id)
            .cloned()
            .ok_or("接続を登録してください")?;
        if request.purpose != Purpose::Probe
            && request.purpose != connection.purpose
            && !(matches!(
                request.purpose,
                Purpose::Translation
                    | Purpose::Direction
                    | Purpose::Layout
                    | Purpose::Edit
                    | Purpose::Lettering
                    | Purpose::Vision
            ) && connection.purpose == Purpose::Plan)
        {
            return Err("用途に対応する接続を選択してください".into());
        }
        {
            let mut submitted = self.submitted.lock().map_err(|_| failure())?;
            if submitted.len() >= 4096 || !submitted.insert(request.request_id.clone()) {
                return Err("送信済み要求または要求上限です".into());
            }
        }
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        self.active
            .lock()
            .map_err(|_| failure())?
            .insert(request.request_id.clone(), cancel);
        if self
            .cancelled
            .lock()
            .map_err(|_| failure())?
            .contains(&request.request_id)
        {
            self.active
                .lock()
                .map_err(|_| failure())?
                .remove(&request.request_id);
            return Err("中止済みの要求です".into());
        }
        let limit = {
            let mut limits = self.limits.lock().map_err(|_| failure())?;
            limits
                .entry(connection.endpoint.clone())
                .or_insert_with(|| {
                    Arc::new(tokio::sync::Semaphore::new(
                        if connection.provider == Provider::Ollama {
                            1
                        } else {
                            2
                        },
                    ))
                })
                .clone()
        };
        let result = tokio::select! {
            result = async {
                let _permit=limit.acquire().await.map_err(|_|failure())?;
                let transport = PolicyTransport::new(&connection.endpoint, connection.provider == Provider::Ollama, connection.path()).await?;
                complete(&connection, &request, transport).with_subscriber(tracing::subscriber::NoSubscriber::default()).await
            } => result,
            _ = cancelled => Err("LLM要求を中止しました。送信済みの場合、処理・課金の有無は未確定です".into()),
        };
        self.active
            .lock()
            .map_err(|_| failure())?
            .remove(&request.request_id);
        let value = result?;
        validate_output(request.purpose, &value)?;
        Ok(Response {
            request_id: request.request_id,
            value,
        })
    }
}
fn message(request: &Request) -> Result<Message, String> {
    let mut content = Vec::new();
    let mut total = request.prompt.len();
    for uri in &request.images {
        let (prefix, data) = uri.split_once(",").ok_or("画像形式が不正です")?;
        let media_type = match prefix {
            "data:image/png;base64" => ImageMediaType::PNG,
            "data:image/jpeg;base64" => ImageMediaType::JPEG,
            "data:image/webp;base64" => ImageMediaType::WEBP,
            _ => return Err("画像形式が不正です".into()),
        };
        total += data.len();
        if total > 20 * 1024 * 1024 || STANDARD.decode(data).is_err() {
            return Err("画像データが不正または大きすぎます".into());
        }
        content.push(UserContent::Image(Image {
            data: DocumentSourceKind::Base64(data.into()),
            media_type: Some(media_type),
            detail: None,
            additional_params: None,
        }));
    }
    content.push(UserContent::text(format!(
        "{}\n\nReturn only a JSON object matching this JSON schema. No markdown or commentary.\n{}",
        request.prompt, request.schema
    )));
    Ok(Message::User { content })
}
async fn perform<M: CompletionModel + Clone>(
    model: M,
    message: Message,
    schema: Option<schemars::Schema>,
    params: Value,
) -> Result<Value, String> {
    let mut request = model
        .completion_request(message)
        .max_tokens(8192)
        .additional_params(params)
        .build();
    request.output_schema = schema;
    request.record_telemetry_content = false;
    normalize(model.completion(request).await.map_err(|_| failure())?)
}
async fn complete<H>(
    connection: &Connection,
    request: &Request,
    transport: H,
) -> Result<Value, String>
where
    H: rig_core::http_client::HttpClientExt
        + Clone
        + std::fmt::Debug
        + Default
        + Send
        + Sync
        + 'static,
{
    if connection.provider == Provider::Jev {
        return complete_jev(connection, request, transport).await;
    }
    let message = message(request)?;
    match connection.provider {
        Provider::Ollama => {
            let client = ollama::Client::builder()
                .api_key(rig_core::client::Nothing)
                .base_url(&connection.endpoint)
                .http_client(transport)
                .build()
                .map_err(|_| failure())?;
            let schema: schemars::Schema =
                serde_json::from_value(request.schema.clone()).map_err(|_| failure())?;
            perform(
                client.completion_model(&connection.model),
                message,
                Some(schema),
                json!({"keep_alive":"0"}),
            )
            .await
        }
        Provider::Anthropic => {
            let client = anthropic::Client::builder()
                .api_key(&connection.credential)
                .base_url(&connection.endpoint)
                .http_client(transport)
                .build()
                .map_err(|_| failure())?;
            perform(
                client.completion_model(&connection.model),
                message,
                None,
                json!({}),
            )
            .await
        }
        _ => {
            // Gemini / DeepSeek / custom preserve their existing OpenAI-compatible endpoint contract.
            let client = openai::CompletionsClient::builder()
                .api_key(&connection.credential)
                .base_url(&connection.endpoint)
                .http_client(transport)
                .build()
                .map_err(|_| failure())?;
            let params = if connection.json_mode {
                json!({"response_format":{"type":"json_object"}})
            } else {
                json!({})
            };
            perform(
                client.completion_model(&connection.model),
                message,
                None,
                params,
            )
            .await
        }
    }
}
// TypeSafe's typed evaluation protocol, not a chat-completions alias.
// Contract checked 2026-09-17: https://docs.typesafe.ai/api
async fn complete_jev<H: rig_core::http_client::HttpClientExt>(
    connection: &Connection,
    request: &Request,
    transport: H,
) -> Result<Value, String> {
    use rig_core::http_client::Request as HttpRequest;
    if request.purpose != Purpose::Classify
        || !request.images.is_empty()
        || request.prompt.len() > 32768
    {
        return Err(failure());
    }
    let state: Value = serde_json::from_str(&request.prompt).map_err(|_| failure())?;
    let body = json!({"model":connection.model,"state":state,"questions":{"operation":{
        "type":"choice","instructions":"漫画の修正指示を分類。判定だけを行い本文を書き換えない。複数の種類ならcompound、不明ならunclear。",
        "criteria":{"lettering":"吹き出し・文字の配置やスタイル","crop":"再作画せず画像の位置と拡大率を変更","layout":"コマ枠の配置と形","direction":"カメラ・人物間距離・ポーズなどBlender演出","region":"画像の一部だけ描き直す","compound":"複数種の操作","readonly":"原作本文の変更","resolution":"必要解像度を診断","upscale":"補間拡大候補","finishing":"元画像から配置に合わせて仕上げ候補を再生成","video_prepare":"動画生成の準備","video_assign":"既存の採用動画を割当","unsupported":"対応操作にない要求","unclear":"対象や意図が不明"}
    }}});
    let req = HttpRequest::builder()
        .method("POST")
        .uri(format!("{}{}", connection.endpoint, connection.path()))
        .header("authorization", format!("Bearer {}", connection.credential))
        .header("content-type", "application/json")
        .body(bytes::Bytes::from(body.to_string()))
        .map_err(|_| failure())?;
    let response = transport
        .send::<_, bytes::Bytes>(req)
        .await
        .map_err(|_| failure())?;
    let bytes = response.into_body().await.map_err(|_| failure())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| failure())?;
    let answer = value["answers"]["operation"].clone();
    validate_output(Purpose::Classify, &answer)?;
    Ok(answer)
}
fn normalize(response: CompletionResponse) -> Result<Value, String> {
    if response.finish_reason() != Some(FinishReason::Stop) {
        return Err("LLM応答が正常終了していません".into());
    }
    let mut text = String::new();
    for part in response.choice {
        match part {
            AssistantContent::Text(t) => text.push_str(&t.text),
            AssistantContent::Reasoning(_) => {}
            _ => return Err("未対応のLLM応答です".into()),
        }
    }
    let text = text.trim();
    let text = text
        .strip_prefix("```json\n")
        .or_else(|| text.strip_prefix("```\n"))
        .and_then(|s| s.strip_suffix("\n```"))
        .unwrap_or(text);
    let value: Value = serde_json::from_str(text).map_err(|_| "LLMのJSON応答が不正です")?;
    if !value.is_object() {
        return Err("JSONオブジェクトが必要です".into());
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanOutput {
    panels: Vec<PanelPlan>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PanelPlan {
    unit_ids: Vec<String>,
    prompt: String,
    character_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TranslationOutput {
    units: Vec<TranslatedUnit>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TranslatedUnit {
    id: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeOutput {
    ok: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectionOutput {
    status: String,
    reason: String,
    operation: Option<crate::blender::Operation>,
}
fn validate_output(purpose: Purpose, value: &Value) -> Result<(), String> {
    match purpose {
        Purpose::Classify => {
            let choices = [
                "lettering",
                "crop",
                "layout",
                "direction",
                "region",
                "compound",
                "readonly",
                "unsupported",
                "unclear",
                "resolution",
                "upscale",
                "finishing",
                "video_prepare",
                "video_assign",
            ];
            if value["type"] != "choice"
                || !choices.contains(&value["choice"].as_str().unwrap_or(""))
                || value["confidence"]
                    .as_f64()
                    .is_none_or(|v| !(0.0..=1.0).contains(&v))
            {
                return Err(failure());
            }
            let probabilities = value["probabilities"].as_object().ok_or_else(failure)?;
            if probabilities.len() != choices.len()
                || choices.iter().any(|key| {
                    probabilities
                        .get(*key)
                        .and_then(Value::as_f64)
                        .is_none_or(|v| !(0.0..=1.0).contains(&v))
                })
                || (probabilities
                    .values()
                    .filter_map(Value::as_f64)
                    .sum::<f64>()
                    - 1.0)
                    .abs()
                    > 0.01
            {
                return Err(failure());
            }
        }
        Purpose::Edit => {
            if value.as_object().is_none_or(|o| o.len() != 2)
                || value["reason"].as_str().is_none_or(|s| s.len() > 4000)
                || value["operations"].as_array().is_none_or(|ops| {
                    ops.len() > 8
                        || ops.iter().any(|op| {
                            ![
                                "lettering",
                                "crop",
                                "layout",
                                "direction",
                                "region",
                                "resolution",
                                "upscale",
                                "finishing",
                                "video_prepare",
                                "video_assign",
                            ]
                            .contains(&op["kind"].as_str().unwrap_or(""))
                                || !op["panelId"].is_string()
                                || !op["args"].is_object()
                        })
                })
            {
                return Err(failure());
            }
        }
        Purpose::Vision => {
            if value.as_object().is_none_or(|o| o.len() != 3)
                || !value["uncertain"].is_boolean()
                || !value["reason"].is_string()
                || value["regions"].as_array().is_none_or(|rs| {
                    rs.len() > 32
                        || rs.iter().any(|r| {
                            !r["panelId"].is_string()
                                || !r["label"].is_string()
                                || !["edit", "avoid", "subject"]
                                    .contains(&r["purpose"].as_str().unwrap_or(""))
                                || r["rect"].as_array().is_none_or(|a| {
                                    a.len() != 4
                                        || a.iter().any(|v| {
                                            v.as_f64().is_none_or(|n| !(0.0..=1.0).contains(&n))
                                        })
                                })
                        })
                })
            {
                return Err(failure());
            }
        }
        Purpose::Lettering => {
            if !value["reason"].is_string() || !value["layout"].is_object() {
                return Err(failure());
            }
            crate::storage::lettering::validate(&value["layout"], None)?;
        }
        Purpose::Layout => {
            let object = value.as_object().ok_or_else(failure)?;
            if object.len() != 2
                || value["reason"]
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty() || s.len() > 4000)
            {
                return Err(failure());
            }
            crate::storage::layout::validate(&json!({"version":1,"pages":value["pages"]}), None)?;
        }
        Purpose::Direction => {
            let output: DirectionOutput =
                serde_json::from_value(value.clone()).map_err(|_| failure())?;
            if output.reason.trim().is_empty() || output.reason.len() > 4000 {
                return Err(failure());
            }
            match (output.status.as_str(), output.operation) {
                ("action", Some(op))
                    if !matches!(
                        op,
                        crate::blender::Operation::Inspect
                            | crate::blender::Operation::Catalog
                            | crate::blender::Operation::Capture { .. }
                    ) =>
                {
                    crate::blender::validate_operation(&op)?;
                }
                ("ready" | "blocked", None) => {}
                _ => return Err(failure()),
            }
        }

        Purpose::Plan => {
            let output: PlanOutput =
                serde_json::from_value(value.clone()).map_err(|_| failure())?;
            if output.panels.is_empty()
                || output.panels.len() > 120
                || output.panels.iter().any(|p| {
                    p.unit_ids.is_empty()
                        || p.prompt.trim().is_empty()
                        || p.character_ids.iter().any(|id| id.is_empty())
                })
            {
                return Err(failure());
            }
        }
        Purpose::Translation => {
            let output: TranslationOutput =
                serde_json::from_value(value.clone()).map_err(|_| failure())?;
            if output.units.is_empty()
                || output.units.len() > 1000
                || output
                    .units
                    .iter()
                    .any(|unit| unit.id.trim().is_empty() || unit.text.trim().is_empty())
            {
                return Err(failure());
            }
            let mut ids = HashSet::new();
            if output.units.iter().any(|unit| !ids.insert(&unit.id)) {
                return Err(failure());
            }
        }
        Purpose::Probe => {
            let output: ProbeOutput =
                serde_json::from_value(value.clone()).map_err(|_| failure())?;
            if !output.ok {
                return Err(failure());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "llm_tests.rs"]
mod tests;
