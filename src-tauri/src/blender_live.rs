//! Explicit, memory-only connection to one authenticated loopback MCP instance.
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Live(pub Mutex<Option<Connection>>);
pub struct Connection {
    port: u16,
    token: String,
    client: String,
    pub work: String,
    pub target: Value,
}
fn field<'a>(v: &'a Value, name: &str) -> Result<&'a str, String> {
    v[name].as_str().filter(|s| !s.is_empty()).ok_or_else(|| format!("Missing {name}"))
}
impl Connection {
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(35)).build().map_err(|e| e.to_string())?;
        let response = client.post(format!("http://127.0.0.1:{}/mcp", self.port))
            .bearer_auth(&self.token).header("MCP-Protocol-Version", "2025-03-26")
            .header("Accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .send().await.map_err(|_| "execution_unknown: 接続が切れました。操作は再送せず再観測してください")?;
        if !response.status().is_success() { return Err("Blender接続失敗：認証・ポート・起動状態を確認してください".into()); }
        if response.content_length().unwrap_or(0) > 96 * 1024 * 1024 { return Err("MCP response too large".into()); }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "MCP response interrupted")? {
            if bytes.len() + chunk.len() > 96 * 1024 * 1024 { return Err("MCP response too large".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid MCP response")?;
        if body["id"] != id || !body["error"].is_null() { return Err(format!("MCP: {}", body["error"]["message"])); }
        Ok(body["result"].clone())
    }
    pub async fn tool(&self, name: &str, mut args: Value) -> Result<Value, String> {
        args["client"] = json!(self.client);
        let r = self.rpc("tools/call", json!({"name":name,"arguments":args})).await?;
        if r["isError"] == true { return Err("MCP tool failed".into()); }
        serde_json::from_str(r["content"][0]["text"].as_str().ok_or("Missing MCP content")?).map_err(|_| "Invalid MCP tool content".into())
    }
    pub fn check(&self, now: &Value) -> Result<(), String> {
        for k in ["instance", "epoch", "file", "scene", "view_layer"] {
            if now[k] != self.target[k] { return Err(format!("target_mismatch: {k} が変わりました。対象を確認して再接続してください")); }
        }
        Ok(())
    }
}
pub async fn command(live: &Live, action: &str, input: Value) -> Result<Value, String> {
    let mut slot = live.0.lock().await;
    if action == "disconnect" {
        if let Some(c) = slot.take() { let _ = c.tool("live_release", json!({})).await; }
        return Ok(Value::Null);
    }
    if action == "connect" {
        if slot.is_some() { return Err("先に現在のlive接続を切断してください".into()); }
        let port = input["port"].as_u64().filter(|p| (1024..=65535).contains(p)).ok_or("Invalid loopback port")? as u16;
        let token = field(&input,"token")?.to_owned();
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid token".into()); }
        let mut c = Connection { port, token, client: uuid::Uuid::new_v4().to_string(), work: field(&input,"work")?.into(), target: Value::Null };
        let init = c.rpc("initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manga-mac","version":"1.0.0"}})).await?;
        if init["serverInfo"]["name"] != "manga-mac-live" || init["serverInfo"]["version"] != "1.0.0" { return Err("未対応のliveアドオンです".into()); }
        let list = c.rpc("tools/list", json!({})).await?;
        if !list["tools"].as_array().is_some_and(|a| a.iter().any(|t| t["name"] == "live_identity")) { return Err("Missing live tool".into()); }
        let target = c.tool("live_identity", json!({})).await?;
        if target["instance"] != input["instance"] || target["telemetry"] != false { return Err("Blender instanceまたは送信設定が一致しません".into()); }
        for k in ["file", "scene", "view_layer"] {
            if target[k] != input[k] { return Err(format!("target_mismatch: {k} をBlender画面で確認してください")); }
        }
        c.target = target.clone();
        c.tool("live_claim", json!({"instance":target["instance"],"epoch":target["epoch"]})).await?;
        *slot = Some(c);
        return Ok(target);
    }
    let c = slot.as_ref().ok_or("live接続がありません")?;
    if input["work"] != c.work { return Err("作品が違います。live接続を切断して接続し直してください".into()); }
    let now = c.tool("live_identity", json!({})).await?;
    c.check(&now)?;
    if action == "status" { return Ok(now); }
    if action == "observe" {
        let result = c.tool("live_observe", input).await?;
        c.check(&result)?;
        return Ok(result);
    }
    Err("Unsupported live action".into())
}
