//! TapNow MCP capability discovery. This never calls a generation tool.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{header, Client, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Mutex, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};

const MCP: &str = "https://mcp.tapnow.ai/api/agent-gateway/mcp/general/mcp";
const RESOURCE: &str = "https://mcp.tapnow.ai/.well-known/oauth-protected-resource/api/agent-gateway/mcp/general/mcp";
const METADATA: &str = "https://oauth.tapnow.ai/.well-known/oauth-authorization-server";
const ISSUER: &str = "https://oauth.tapnow.ai";

#[derive(Default)]
pub struct Connection(pub Mutex<Option<String>>);

fn client() -> Result<Client, String> {
    Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20)).build().map_err(|_| "TapNow接続を開始できません".into())
}

async fn response_json(response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() { return Err(format!("TapNowの認証設定を取得できません (HTTP {})", response.status())); }
    response.json().await.map_err(|_| "TapNowの認証設定を読み取れません".into())
}

async fn registration_error(response: reqwest::Response) -> String {
    let status = response.status();
    let code = response.json::<Value>().await.ok()
        .and_then(|body| body["error"].as_str().map(str::to_owned))
        .filter(|code| matches!(code.as_str(), "invalid_client_metadata" | "invalid_redirect_uri" | "invalid_scope"));
    match code {
        Some(code) => format!("TapNowがMacアプリのOAuth登録を受け付けません (HTTP {status}, {code})"),
        None => format!("TapNowがMacアプリのOAuth登録を受け付けません (HTTP {status})"),
    }
}

fn validate_metadata(resource: &Value, auth: &Value) -> Result<(), String> {
    if resource["resource"] != MCP || auth["issuer"] != ISSUER
        || !resource["authorization_servers"].as_array().is_some_and(|v| v.iter().any(|x| x == ISSUER))
        || !auth["code_challenge_methods_supported"].as_array().is_some_and(|v| v.iter().any(|x| x == "S256")) {
        return Err("TapNowのMCP認証先が公式の接続先と一致しません".into());
    }
    for key in ["authorization_endpoint", "token_endpoint", "registration_endpoint"] {
        let endpoint = auth[key].as_str().ok_or("TapNowの認証先が不足しています")?;
        let url = Url::parse(endpoint).map_err(|_| "TapNowの認証先が不正です")?;
        if url.scheme() != "https" || url.host_str() != Some("oauth.tapnow.ai") || url.username() != "" || url.password().is_some() {
            return Err("TapNowの認証先が不正です".into());
        }
    }
    Ok(())
}

async fn oauth_callback(listener: TcpListener, state: &str) -> Result<String, String> {
    let (mut stream, peer) = tokio::time::timeout(Duration::from_secs(180), listener.accept())
        .await.map_err(|_| "TapNow認証が時間切れです")?.map_err(|_| "認証の戻り先を受信できません")?;
    if !peer.ip().is_loopback() { return Err("認証の戻り先が不正です".into()); }
    let mut bytes = [0u8; 4096];
    let size = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut bytes))
        .await.map_err(|_| "認証の応答が時間切れです")?.map_err(|_| "認証の応答を読めません")?;
    let request = std::str::from_utf8(&bytes[..size]).map_err(|_| "認証の応答が不正です")?;
    let path = request.lines().next().and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.split_once(' ')).map(|(path, _)| path).ok_or("認証の応答が不正です")?;
    let url = Url::parse(&format!("http://127.0.0.1{path}")).map_err(|_| "認証の応答が不正です")?;
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let valid = url.path() == "/tapnow/callback" && params.get("state").map(String::as_str) == Some(state)
        && params.get("iss").map(String::as_str).is_none_or(|iss| iss == ISSUER);
    let code = if valid { params.get("code").filter(|code| !code.is_empty()).cloned() } else { None };
    let message = if code.is_some() { "TapNowの認証を受け取りました。アプリへ戻ってください。" } else { "TapNowの認証を完了できませんでした。" };
    let body = message.as_bytes();
    let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.write_all(body).await;
    code.ok_or("TapNowの認証を完了できませんでした".into())
}

pub async fn connect(connection: &Connection) -> Result<Value, String> {
    let http = client()?;
    let resource = response_json(http.get(RESOURCE).send().await.map_err(|_| "TapNowへ接続できません")?).await?;
    let auth = response_json(http.get(METADATA).send().await.map_err(|_| "TapNowへ接続できません")?).await?;
    validate_metadata(&resource, &auth)?;
    if !resource["scopes_supported"].as_array().is_some_and(|v| v.iter().any(|x| x == "mcp.tools.read")) {
        return Err("TapNowの読み取り権限を確認できません".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| "認証の戻り先を開けません")?;
    let redirect = format!("http://127.0.0.1:{}/tapnow/callback", listener.local_addr().map_err(|_| "認証の戻り先を確認できません")?.port());
    let entropy = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let verifier = URL_SAFE_NO_PAD.encode(entropy.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = uuid::Uuid::new_v4().to_string();
    let registration = http.post(auth["registration_endpoint"].as_str().unwrap())
        .json(&json!({"client_name":"Manga Mac", "application_type":"native", "redirect_uris":[redirect],
            "grant_types":["authorization_code"], "response_types":["code"], "token_endpoint_auth_method":"none",
            "scope":"mcp.tools.read"}))
        .send().await.map_err(|_| "TapNowへアプリを登録できません")?;
    if !registration.status().is_success() { return Err(registration_error(registration).await); }
    let registration = response_json(registration).await?;
    let client_id = registration["client_id"].as_str().ok_or("TapNowからクライアントIDが返されません")?;
    let mut authorize = Url::parse(auth["authorization_endpoint"].as_str().unwrap()).map_err(|_| "認証先が不正です")?;
    authorize.query_pairs_mut().append_pair("response_type", "code").append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect).append_pair("scope", "mcp.tools.read")
        .append_pair("code_challenge", &challenge).append_pair("code_challenge_method", "S256")
        .append_pair("state", &state).append_pair("resource", MCP);
    #[cfg(target_os = "macos")]
    {
        let opened = std::process::Command::new("open").arg(authorize.as_str()).status()
            .map_err(|_| "ブラウザでTapNow認証を開けません")?;
        if !opened.success() { return Err("ブラウザでTapNow認証を開けません".into()); }
    }
    #[cfg(not(target_os = "macos"))]
    return Err("TapNow認証はMacアプリで実行してください".into());
    let code = oauth_callback(listener, &state).await?;
    let token = http.post(auth["token_endpoint"].as_str().unwrap()).form(&[
        ("grant_type", "authorization_code"), ("code", code.as_str()), ("client_id", client_id),
        ("redirect_uri", redirect.as_str()), ("code_verifier", verifier.as_str()), ("resource", MCP),
    ]).send().await.map_err(|_| "TapNowの認証を完了できません")?;
    let token = response_json(token).await?;
    let bearer = token["access_token"].as_str().filter(|x| !x.is_empty()).ok_or("TapNowのアクセストークンがありません")?;
    if token["scope"].as_str().is_some_and(|scope| !scope.split_whitespace().any(|s| s == "mcp.tools.read")) {
        return Err("TapNowの読み取り権限が付与されませんでした".into());
    }
    // 認可だけではMCP接続を確認できない。tools/listが成功してから接続済みにする。
    let tools = list_tools_with_bearer(bearer).await?;
    *connection.0.lock().map_err(|_| "TapNow接続を保持できません")? = Some(bearer.to_owned());
    Ok(json!({"connected":true,"scope":"mcp.tools.read","tools":tools["tools"]}))
}

pub fn disconnect(connection: &Connection) -> Result<(), String> {
    *connection.0.lock().map_err(|_| "TapNow接続を解除できません")? = None;
    Ok(())
}
pub fn connected(connection: &Connection) -> Result<bool, String> {
    Ok(connection.0.lock().map_err(|_| "TapNow接続を確認できません")?.is_some())
}

fn decode_mcp(body: &str, sse: bool, expected_id: i32) -> Result<Value, String> {
    if !sse {
        let value: Value = serde_json::from_str(body).map_err(|_| "TapNowのMCP応答が不正です")?;
        return if value["id"] == expected_id { Ok(value) } else { Err("TapNowのMCP応答IDが不正です".into()) };
    }
    for line in body.lines() {
        if let Some(data) = line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:")) {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                if value["id"] == expected_id { return Ok(value); }
            }
        }
    }
    Err("TapNowのMCP応答が空です".into())
}

pub async fn list_tools(connection: &Connection) -> Result<Value, String> {
    let bearer = connection.0.lock().map_err(|_| "TapNow接続を確認できません")?
        .clone().ok_or("TapNowへ接続してください")?;
    list_tools_with_bearer(&bearer).await
}

async fn list_tools_with_bearer(bearer: &str) -> Result<Value, String> {
    let http = client()?;
    let mut session: Option<String> = None;
    for (id, method, params) in [
        (1, "initialize", json!({"protocolVersion":"2025-03-26", "capabilities":{}, "clientInfo":{"name":"manga-mac","version":"0.1.0"}})),
        (2, "notifications/initialized", json!({})),
        (3, "tools/list", json!({})),
    ] {
        let mut request = http.post(MCP).bearer_auth(&bearer).header(header::ACCEPT, "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-03-26");
        if let Some(ref value) = session { request = request.header("Mcp-Session-Id", value); }
        let payload = if method == "notifications/initialized" {
            json!({"jsonrpc":"2.0", "method":method})
        } else {
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
        };
        let response = request.json(&payload)
            .send().await.map_err(|_| "TapNowのツール一覧を取得できません")?;
        if !response.status().is_success() { return Err(format!("TapNowのMCP接続に失敗しました (HTTP {})", response.status())); }
        if let Some(value) = response.headers().get("Mcp-Session-Id") {
            session = Some(value.to_str().map_err(|_| "TapNowの接続状態が不正です")?.to_owned());
        }
        if method == "notifications/initialized" { continue; }
        let sse = response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));
        let value = decode_mcp(&response.text().await.map_err(|_| "TapNowのMCP応答を読めません")?, sse, id)?;
        if value.get("error").is_some() { return Err("TapNowのMCPが要求を拒否しました".into()); }
        if method == "tools/list" {
            let tools = value["result"]["tools"].as_array().ok_or("TapNowのツール形式が不正です")?;
            return Ok(json!({"tools":tools.iter().map(|tool| json!({
                "name":tool["name"], "description":tool["description"], "inputSchema":tool["inputSchema"],
                "outputSchema":tool["outputSchema"]
            })).collect::<Vec<_>>() }));
        }
    }
    Err("TapNowのツールを取得できません".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untrusted_metadata_and_ignores_unrelated_sse_events() {
        let resource = json!({"resource":MCP,"authorization_servers":[ISSUER]});
        let auth = json!({"issuer":ISSUER,"code_challenge_methods_supported":["S256"],
            "authorization_endpoint":"https://oauth.tapnow.ai/authorize", "token_endpoint":"https://oauth.tapnow.ai/token",
            "registration_endpoint":"https://oauth.tapnow.ai/oauth/register"});
        assert!(validate_metadata(&resource, &auth).is_ok());
        let mut wrong = auth.clone(); wrong["token_endpoint"] = json!("https://other.example/token");
        assert!(validate_metadata(&resource, &wrong).is_err());
        assert_eq!(decode_mcp("event: notification\ndata: {\"method\":\"progress\"}\n\nevent: message\ndata: {\"id\":3,\"result\":{\"tools\":[]}}\n\n", true, 3).unwrap()["result"]["tools"], json!([]));
        assert!(decode_mcp("{\"id\":2,\"result\":{}}", false, 3).is_err());
    }
}
