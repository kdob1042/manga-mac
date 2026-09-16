// Transport policy only. Provider JSON and response parsing belong to rig-core.
use bytes::Bytes;
use rig_core::http_client::{self, HttpClientExt, LazyBody, MultipartForm, Request, Response, StreamingResponse};
use std::{net::{IpAddr, SocketAddr}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};

const REQUEST_LIMIT: usize = 24 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;

fn rejected() -> http_client::Error {
    http_client::Error::Instance(Box::new(std::io::Error::other("LLM transport rejected the request")))
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
                && !ip.is_broadcast() && !ip.is_documentation() && !ip.is_unspecified()
                && a != 0 && a < 224 && !(a == 100 && (64..=127).contains(&b))
                && !(a == 198 && (b == 18 || b == 19))
                && !(a == 192 && b == 0 && c == 0)
        }
        IpAddr::V6(ip) => {
            let parts = ip.segments();
            // Only global unicast. Mapped IPv4, local, transition and documentation ranges are rejected.
            (parts[0] & 0xe000) == 0x2000 && parts[0] != 0x2002
                && !(parts[0] == 0x2001 && (parts[1] < 0x200 || parts[1] == 0xdb8))
                && !(parts[0] == 0x3fff && parts[1] < 0x1000)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct PolicyTransport {
    target: String,
    client: Option<reqwest::Client>,
    // One transport is created per application request. SDK clones share its attempt budget.
    attempted: Arc<AtomicBool>,
}

impl PolicyTransport {
    // Media uses the same DNS pinning/no-proxy/no-redirect boundary, with its
    // own exact host/path/method checks and response limits in the adapter.
    pub async fn external_client(url: &reqwest::Url) -> Result<reqwest::Client, String> {
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err("Invalid external URL".into());
        }
        Self::new(&url.origin().ascii_serialization(), false, "").await?.client.ok_or("Missing HTTP client".into())
    }
    pub async fn new(endpoint: &str, local: bool, path: &str) -> Result<Self, String> {
        let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid endpoint")?;
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
            return Err("Endpoint must not contain credentials, query, or fragment".into());
        }
        let host = url.host_str().ok_or("Endpoint host is required")?;
        let port = url.port_or_known_default().ok_or("Endpoint port is required")?;
        let addresses: Vec<SocketAddr> = if local {
            if url.origin().ascii_serialization() != "http://127.0.0.1:11434" {
                return Err("Only the approved Ollama loopback endpoint is allowed".into());
            }
            vec![SocketAddr::from(([127, 0, 0, 1], 11434))]
        } else {
            if url.scheme() != "https" || port != 443 { return Err("External endpoints require HTTPS on port 443".into()); }
            let addresses: Vec<_> = tokio::time::timeout(Duration::from_secs(15), tokio::net::lookup_host((host, port))).await.map_err(|_| "Endpoint resolution timed out")?.map_err(|_| "Endpoint resolution failed")?.collect();
            if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
                return Err("External endpoint resolved to a prohibited address".into());
            }
            addresses
        };
        let client = reqwest::Client::builder()
            .no_proxy().http1_only().redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(600))
            .resolve_to_addrs(host, &addresses).build().map_err(|_| "HTTP client initialization failed")?;
        Ok(Self { target: format!("{}{path}", endpoint.trim_end_matches('/')), client: Some(client), attempted: Arc::new(AtomicBool::new(false)) })
    }
}

impl HttpClientExt for PolicyTransport {
    fn send<T, U>(&self, request: Request<T>) -> impl std::future::Future<Output = http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where T: Into<Bytes> + Send, U: From<Bytes> + Send + 'static {
        let client = self.client.clone();
        let target = self.target.clone();
        let attempted = self.attempted.clone();
        let (parts, body) = request.into_parts();
        let body: Bytes = body.into();
        async move {
            let url = reqwest::Url::parse(&parts.uri.to_string()).map_err(|_| rejected())?;
            if url.as_str() != target || !url.username().is_empty()
                || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
                || parts.headers.contains_key("host") || parts.headers.contains_key("proxy-authorization")
                || parts.method != http_client::Method::POST || body.len() > REQUEST_LIMIT {
                return Err(rejected());
            }
            // Consume before the network await: failures and cancellation must not reopen the budget.
            if attempted.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                return Err(rejected());
            }
            let mut response = client.ok_or_else(rejected)?.post(url).headers(parts.headers).body(body).send().await.map_err(|_| rejected())?;
            if !response.status().is_success() {
                return Err(http_client::Error::InvalidStatusCodeWithDetails {
                    status: response.status(), body: String::new(), headers: Box::default(),
                });
            }
            if response.content_length().is_some_and(|n| n > RESPONSE_LIMIT as u64) { return Err(rejected()); }
            let content_type = response.headers().get("content-type").and_then(|h| h.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim();
            if content_type != "application/json" { return Err(rejected()); }
            let status = response.status();
            let mut data = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| rejected())? {
                if data.len() + chunk.len() > RESPONSE_LIMIT { return Err(rejected()); }
                data.extend_from_slice(&chunk);
            }
            let body: LazyBody<U> = Box::pin(async move { Ok(U::from(Bytes::from(data))) });
            Response::builder().status(status).header("content-type", "application/json").body(body).map_err(Into::into)
        }
    }

    #[allow(clippy::manual_async_fn)]
    fn send_multipart<U>(&self, _: Request<MultipartForm>) -> impl std::future::Future<Output = http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where U: From<Bytes> + Send + 'static {
        async { Err(rejected()) }
    }

    #[allow(clippy::manual_async_fn)]
    fn send_streaming<T>(&self, _: Request<T>) -> impl std::future::Future<Output = http_client::Result<StreamingResponse>> + Send
    where T: Into<Bytes> + Send {
        async { Err(rejected()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[test]
    fn prohibited_addresses() {
        for address in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "192.0.0.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "2606:4700:4700::1111"] { assert!(public_ip(address.parse().unwrap())); }
    }
    #[tokio::test]
    async fn policy_rejects_unapproved_origins_before_sending() {
        for endpoint in ["http://api.example/v1", "https://user:secret@api.example", "https://api.example?key=secret", "https://api.example/#part", "https://api.example:8443", "https://127.0.0.1", "https://169.254.169.254"] {
            assert!(PolicyTransport::new(endpoint, false, "/chat/completions").await.is_err());
        }
        assert!(PolicyTransport::new("http://localhost:11434", true, "/api/chat").await.is_err());
        let client=PolicyTransport::new("http://127.0.0.1:11434", true, "/api/chat").await.unwrap();
        for (method,url) in [("GET","http://127.0.0.1:11434/api/chat"),("POST","https://elsewhere.example/api/chat"),("POST","http://127.0.0.1:11434/api/pull"),("POST","http://127.0.0.1:11434/api/chat?x=y")] {
            let request=Request::builder().method(method).uri(url).body(Bytes::from_static(b"{}" )).unwrap();
            assert!(client.send::<_,Bytes>(request).await.is_err());
        }
        assert!(PolicyTransport::default().send::<_,Bytes>(Request::builder().method("POST").uri("http://127.0.0.1:11434/api/chat").body(Bytes::from_static(b"{}")).unwrap()).await.is_err());
    }
    #[tokio::test]
    async fn real_http_does_not_follow_redirect_or_retry_errors_and_bounds_response() {
        // Artificial localhost server: no paid endpoint, real credential or manuscript.
        let sink=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        sink.set_nonblocking(true).unwrap();
        for response in [
            format!("HTTP/1.1 302 Found\r\nLocation: http://{}/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",sink.local_addr().unwrap()),
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", RESPONSE_LIMIT+1),
        ] {
            let server=std::net::TcpListener::bind("127.0.0.1:11434").unwrap();
            let thread=std::thread::spawn(move || {
                let (mut socket,_)=server.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut data=Vec::new();let mut byte=[0;1];
                while !data.ends_with(b"\r\n\r\n") {socket.read_exact(&mut byte).unwrap();data.push(byte[0]);}
                let mut body=[0;2];socket.read_exact(&mut body).unwrap();assert_eq!(&body,b"{}");
                socket.write_all(response.as_bytes()).unwrap();drop(socket);
                server.set_nonblocking(true).unwrap();std::thread::sleep(Duration::from_millis(50));assert!(server.accept().is_err());
            });
            let client=PolicyTransport::new("http://127.0.0.1:11434",true,"/api/chat").await.unwrap();
            let request=Request::builder().method("POST").uri("http://127.0.0.1:11434/api/chat").body(Bytes::from_static(b"{}")).unwrap();
            assert!(client.send::<_,Bytes>(request).await.is_err());thread.join().unwrap();assert!(sink.accept().is_err());
        }
    }
    #[tokio::test]
    async fn sdk_clones_cannot_send_a_second_post_after_success_or_failure() {
        for status in ["200 OK", "429 Too Many Requests"] {
            let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = server.local_addr().unwrap();
            let worker = server.try_clone().unwrap();
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
            let thread = std::thread::spawn(move || {
                let (mut socket, _) = worker.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut data = Vec::new();
                let mut byte = [0; 1];
                while !data.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    data.push(byte[0]);
                }
                let mut body = [0; 2];
                socket.read_exact(&mut body).unwrap();
                assert_eq!(&body, b"{}");
                socket.write_all(response.as_bytes()).unwrap();
            });
            // Test-only ephemeral endpoint; production registration stays fixed to approved origins.
            let target = format!("http://{address}/api/chat");
            let transport = PolicyTransport {
                target: target.clone(),
                client: Some(reqwest::Client::builder().no_proxy().http1_only()
                    .redirect(reqwest::redirect::Policy::none()).build().unwrap()),
                attempted: Arc::new(AtomicBool::new(false)),
            };
            let sdk_clone = transport.clone();
            let make_request = || Request::builder().method("POST").uri(target.as_str())
                .body(Bytes::from_static(b"{}")).unwrap();
            let first = transport.send::<_, Bytes>(make_request()).await;
            assert_eq!(first.is_ok(), status == "200 OK");
            thread.join().unwrap();
            let second = tokio::time::timeout(Duration::from_millis(200),
                sdk_clone.send::<_, Bytes>(make_request())).await;
            assert!(matches!(second, Ok(Err(_))));
            server.set_nonblocking(true).unwrap();
            assert_eq!(server.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        }
    }

}
