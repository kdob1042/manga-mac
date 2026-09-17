use super::*;
use bytes::Bytes;
use rig_core::http_client::{
    self, HttpClientExt, LazyBody, MultipartForm, Request as HttpRequest, Response as HttpResponse,
    StreamingResponse,
};
type Calls = Arc<Mutex<Vec<(String, http::HeaderMap, Value)>>>;
#[derive(Clone, Default, Debug)]
struct Fixture {
    response: String,
    calls: Calls,
}
fn denied() -> http_client::Error {
    http_client::Error::Instance(Box::new(std::io::Error::other(
        "fixture prohibited operation",
    )))
}
impl HttpClientExt for Fixture {
    fn send<T, U>(
        &self,
        request: HttpRequest<T>,
    ) -> impl std::future::Future<Output = http_client::Result<HttpResponse<LazyBody<U>>>> + Send + 'static
    where
        T: Into<Bytes> + Send,
        U: From<Bytes> + Send + 'static,
    {
        let (parts, body) = request.into_parts();
        let body: Bytes = body.into();
        self.calls.lock().unwrap().push((
            parts.uri.to_string(),
            parts.headers,
            serde_json::from_slice(&body).unwrap(),
        ));
        let data = Bytes::from(self.response.clone());
        async move {
            let body: LazyBody<U> = Box::pin(async move { Ok(U::from(data)) });
            Ok(HttpResponse::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(body)
                .unwrap())
        }
    }
    #[allow(clippy::manual_async_fn)]
    fn send_multipart<U>(
        &self,
        _: HttpRequest<MultipartForm>,
    ) -> impl std::future::Future<Output = http_client::Result<HttpResponse<LazyBody<U>>>> + Send + 'static
    where
        U: From<Bytes> + Send + 'static,
    {
        async { Err(denied()) }
    }
    #[allow(clippy::manual_async_fn)]
    fn send_streaming<T>(
        &self,
        _: HttpRequest<T>,
    ) -> impl std::future::Future<Output = http_client::Result<StreamingResponse>> + Send
    where
        T: Into<Bytes> + Send,
    {
        async { Err(denied()) }
    }
}
fn response(provider: Provider, reason: &str, content: &str) -> Value {
    match provider {
        Provider::Ollama => {
            json!({"model":"openai/not-routed","created_at":"2026-09-14T00:00:00Z","message":{"role":"assistant","content":content},"done":true,"done_reason":reason,"total_duration":0,"load_duration":0,"prompt_eval_count":1,"prompt_eval_duration":0,"eval_count":1,"eval_duration":0})
        }
        Provider::Anthropic => {
            json!({"id":"test","type":"message","role":"assistant","model":"test-model","content":[{"type":"text","text":content}],"stop_reason":reason,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}})
        }
        _ => {
            json!({"id":"test","object":"chat.completion","created":1,"model":"test-model","choices":[{"index":0,"finish_reason":reason,"message":{"role":"assistant","content":content}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})
        }
    }
}
fn request() -> Request {
    Request {
        purpose: Purpose::Probe,
        connection_id: "fixture".into(),
        request_id: id(),
        prompt: "artificial manuscript".into(),
        schema: json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}),
        images: vec![
            "data:image/jpeg;base64,YWJj".into(),
            "data:image/png;base64,ZGVm".into(),
        ],
    }
}
fn connection(provider: Provider) -> Connection {
    Connection {
        provider,
        purpose: Purpose::Plan,
        endpoint: if provider == Provider::Ollama {
            "http://127.0.0.1:11434"
        } else {
            "https://approved.example/v1"
        }
        .into(),
        model: "openai/not-routed".into(),
        credential: "fixture-only-secret".into(),
        json_mode: true,
    }
}
#[tokio::test]
async fn explicit_provider_preserves_model_images_json_and_one_request() {
    for provider in [
        Provider::Ollama,
        Provider::Openai,
        Provider::Gemini,
        Provider::Anthropic,
        Provider::Deepseek,
        Provider::Custom,
    ] {
        let reason = if provider == Provider::Anthropic {
            "end_turn"
        } else {
            "stop"
        };
        let fixture = Fixture {
            response: response(provider, reason, "{\"ok\":true}").to_string(),
            ..Default::default()
        };
        assert_eq!(
            complete(&connection(provider), &request(), fixture.clone())
                .await
                .unwrap(),
            json!({"ok":true})
        );
        let calls = fixture.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (url, headers, body) = &calls[0];
        assert_eq!(body["model"], "openai/not-routed");
        assert!(!body.to_string().contains("fixture-only-secret"));
        if provider == Provider::Ollama {
            assert_eq!(url, "http://127.0.0.1:11434/api/chat");
            assert_eq!(body["keep_alive"], "0");
            assert_eq!(body["format"], request().schema);
            assert_eq!(body["messages"][0]["images"], json!(["YWJj", "ZGVm"]));
            assert!(!headers.contains_key("authorization"));
        } else if provider == Provider::Anthropic {
            assert_eq!(headers["x-api-key"], "fixture-only-secret");
            assert_eq!(body["max_tokens"], 8192);
            assert_eq!(
                body["messages"][0]["content"][0]["source"]["media_type"],
                "image/jpeg"
            );
            assert_eq!(
                body["messages"][0]["content"][1]["source"]["media_type"],
                "image/png"
            );
        } else {
            assert_eq!(headers["authorization"], "Bearer fixture-only-secret");
            assert_eq!(body["response_format"]["type"], "json_object");
            let images: Vec<_> = body["messages"][0]["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|p| p["image_url"]["url"].as_str())
                .collect();
            assert_eq!(images, request().images);
        }
    }
}
#[tokio::test]
async fn invalid_partial_refused_and_empty_responses_never_succeed_or_retry() {
    for provider in [Provider::Ollama, Provider::Openai, Provider::Anthropic] {
        let valid = if provider == Provider::Anthropic {
            "end_turn"
        } else {
            "stop"
        };
        for (reason, content) in [
            ("length", "{}"),
            ("max_tokens", "{}"),
            ("content_filter", "{}"),
            (valid, "not json"),
            (valid, "[]"),
            (valid, ""),
        ] {
            let fixture = Fixture {
                response: response(provider, reason, content).to_string(),
                ..Default::default()
            };
            assert!(complete(&connection(provider), &request(), fixture.clone())
                .await
                .is_err());
            assert_eq!(fixture.calls.lock().unwrap().len(), 1);
        }
    }
}
#[tokio::test]
async fn malformed_input_is_rejected_before_provider_send_and_custom_can_disable_json_mode() {
    let mut input = request();
    input.images = vec!["https://unapproved/image".into()];
    let fixture = Fixture::default();
    assert!(
        complete(&connection(Provider::Openai), &input, fixture.clone())
            .await
            .is_err()
    );
    assert!(fixture.calls.lock().unwrap().is_empty());
    let fixture = Fixture {
        response: response(Provider::Custom, "stop", "{}").to_string(),
        ..Default::default()
    };
    let mut c = connection(Provider::Custom);
    c.json_mode = false;
    complete(&c, &request(), fixture.clone()).await.unwrap();
    assert!(fixture.calls.lock().unwrap()[0]
        .2
        .get("response_format")
        .is_none());
}

#[tokio::test]
async fn registry_rejects_unknown_connections_and_cancelled_ids_without_network() {
    let registry = Connections::default();
    let input = request();
    assert!(registry.request(input).await.is_err());
    let request_id = id();
    registry.cancel(&request_id).unwrap();
    assert!(registry.submitted.lock().unwrap().contains(&request_id));
    assert!(registry.active.lock().unwrap().is_empty());
    assert!(serde_json::from_value::<Request>(json!({"connection_id":"fixture","request_id":id(),"prompt":"synthetic","schema":{},"images":[],"endpoint":"https://unapproved.example"})).is_err());
}

#[test]
fn typed_outputs_reject_wrong_field_types_and_removed_face_purpose() {
    assert!(serde_json::from_value::<Purpose>(json!("face")).is_err());
    assert!(validate_output(
        Purpose::Plan,
        &json!({"panels":[{"unitIds":[42],"prompt":"synthetic","characterIds":[]}]})
    )
    .is_err());
    assert!(validate_output(
        Purpose::Translation,
        &json!({"units":[{"id":"S01:u0","text":"English"}]})
    )
    .is_ok());
    assert!(validate_output(
        Purpose::Translation,
        &json!({"units":[{"id":"S01:u0","text":"A"},{"id":"S01:u0","text":"B"}]})
    )
    .is_err());
    assert!(validate_output(
        Purpose::Translation,
        &json!({"units":[{"id":"S01:u0","text":""}]})
    )
    .is_err());
}

#[test]
fn direction_uses_typed_blender_operations_and_rejects_code_and_invalid_bounds() {
    for value in [
        json!({"status":"action","reason":"寄る","operation":{"kind":"camera","lens":80}}),
        json!({"status":"ready","reason":"撮影へ","operation":null}),
        json!({"status":"blocked","reason":"素材不足","operation":null}),
    ] {
        assert!(validate_output(Purpose::Direction, &value).is_ok());
    }
    for operation in [
        json!({"kind":"python","code":"anything"}),
        json!({"kind":"capture","width":768,"height":768}),
        json!({"kind":"aim","location":[0,0,0],"target":[0,0,0],"lens":50}),
        json!({"kind":"camera","lens":999}),
        json!({"kind":"light","object":"Light","energy":-1,"color":[1,1,1]}),
    ] {
        assert!(validate_output(
            Purpose::Direction,
            &json!({"status":"action","reason":"test","operation":operation})
        )
        .is_err());
    }
}

#[test]
fn layout_output_uses_validated_geometry_on_plan_connection() {
    let good = json!({"reason":"大ゴマ","pages":[{"id":"page","slots":[{"id":"slot","panelId":"p","points":[[0.1,0.1],[0.9,0.1],[0.8,0.9],[0.2,0.9]]}]}]});
    assert!(validate_output(Purpose::Layout, &good).is_ok());
    let mut bad = good.clone();
    bad["pages"][0]["slots"][0]["points"][2] = json!([0.0, 0.0]);
    assert!(validate_output(Purpose::Layout, &bad).is_err());
    assert!(validate_output(Purpose::Plan, &good).is_err());
}

#[tokio::test]
async fn jev_uses_typed_evaluation_without_chat_or_images() {
    let answer = json!({"type":"choice","choice":"crop","confidence":0.9,"probabilities":{"lettering":0.01,"crop":0.92,"layout":0.01,"direction":0.01,"region":0.01,"compound":0.01,"readonly":0.01,"unsupported":0.01,"unclear":0.01}});
    let fixture = Fixture {
        response: json!({"model":"jev-latest","answers":{"operation":answer}}).to_string(),
        ..Default::default()
    };
    let mut c = connection(Provider::Jev);
    c.endpoint = "https://api.typesafe.ai".into();
    c.purpose = Purpose::Classify;
    c.model = "jev-latest".into();
    let mut r = request();
    r.purpose = Purpose::Classify;
    r.prompt = json!({"instruction":"3コマ目の画像を右へ","operations":["crop"]}).to_string();
    r.images.clear();
    let value = complete(&c, &r, fixture.clone()).await.unwrap();
    assert_eq!(value["choice"], "crop");
    let calls = fixture.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "https://api.typesafe.ai/v1/systemone");
    assert_eq!(calls[0].2["questions"]["operation"]["type"], "choice");
    assert!(calls[0].2.get("messages").is_none());
    drop(calls);
    r.images.push("data:image/png;base64,AAAA".into());
    assert!(complete(&c, &r, fixture.clone()).await.is_err());
    assert_eq!(fixture.calls.lock().unwrap().len(), 1);
    let mut bad = value;
    bad["confidence"] = json!(2);
    assert!(validate_output(Purpose::Classify, &bad).is_err());
}
