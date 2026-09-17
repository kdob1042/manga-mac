use reqwest::{header, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::Write,
    net::{IpAddr, SocketAddr},
    path::Path,
    time::Duration,
};

const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DownloadRequest {
    pub download_url: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub source_page: String,
    pub license: String,
}

#[derive(Serialize)]
pub struct DownloadedAsset {
    pub file: String,
    pub hash: String,
    pub bytes: u64,
    pub source_url: String,
    pub source_page: Option<String>,
    pub license: String,
}

fn message() -> String {
    "Web素材を取得できませんでした。URL・ファイル形式・配布条件を確認してください".into()
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn valid_filename(value: &str) -> bool {
    valid_text(value, 128)
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && matches!(
            value
                .rsplit('.')
                .next()
                .map(|part| part.to_ascii_lowercase())
                .as_deref(),
            Some("blend" | "glb" | "gltf" | "fbx" | "obj" | "zip")
        )
}

fn parse_https(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| message())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(message());
    }
    Ok(url)
}

fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            if segments[..6] == [0, 0, 0, 0, 0, 0xffff] {
                let ipv4 = std::net::Ipv4Addr::new(
                    (segments[6] >> 8) as u8,
                    segments[6] as u8,
                    (segments[7] >> 8) as u8,
                    segments[7] as u8,
                );
                return public_address(IpAddr::V4(ipv4));
            }
            let first = segments[0];
            !(ip.is_unspecified()
                || ip.is_loopback()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first & 0xff00) == 0xff00
                || (first == 0x2001 && ip.segments()[1] == 0x0db8))
        }
    }
}

fn public_copy(url: &Url) -> String {
    let mut copy = url.clone();
    copy.set_query(None);
    copy.set_fragment(None);
    copy.to_string()
}

async fn get(url: &Url) -> Result<reqwest::Response, String> {
    let host = url.host_str().ok_or_else(message)?.to_string();
    let port = url.port_or_known_default().ok_or_else(message)?;
    let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| message())?
        .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !public_address(address.ip()))
    {
        return Err(message());
    }
    let address = addresses[0];
    let client = reqwest::Client::builder()
        .user_agent("manga-mac/0.1")
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .resolve(&host, SocketAddr::new(address.ip(), port))
        .build()
        .map_err(|_| message())?;
    client
        .get(url.clone())
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| message())
}

pub async fn download(root: &Path, input: DownloadRequest) -> Result<DownloadedAsset, String> {
    let license = input.license.trim();
    if !valid_text(license, 200) {
        return Err("ライセンス表記を入力してください".into());
    }
    let source_page = if input.source_page.trim().is_empty() {
        None
    } else {
        Some(public_copy(&parse_https(input.source_page.trim())?))
    };
    let mut current = parse_https(input.download_url.trim())?;
    let mut response = None;
    for redirect in 0..=MAX_REDIRECTS {
        let candidate = get(&current).await?;
        if candidate.status().is_redirection() {
            if redirect == MAX_REDIRECTS {
                return Err(message());
            }
            let location = candidate
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(message)?;
            current = parse_https(current.join(location).map_err(|_| message())?.as_str())?;
            continue;
        }
        if candidate.status() != StatusCode::OK {
            return Err(message());
        }
        response = Some(candidate);
        break;
    }
    let mut response = response.ok_or_else(message)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOWNLOAD)
    {
        return Err("Web素材は512MB以下にしてください".into());
    }
    let inferred = current
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or("");
    let file_name = if input.file_name.trim().is_empty() {
        inferred
    } else {
        input.file_name.trim()
    };
    if !valid_filename(file_name) {
        return Err("保存名は英数字・._-のみ、対応拡張子はblend/glb/gltf/fbx/obj/zipです".into());
    }

    let web_root = root.join("web-assets");
    std::fs::create_dir_all(&web_root).map_err(|_| message())?;
    let id = uuid::Uuid::new_v4().to_string();
    let folder = web_root.join(&id);
    std::fs::create_dir(&folder).map_err(|_| message())?;
    let target = folder.join(file_name);
    let outcome = async {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| message())?;
        let mut digest = Sha256::new();
        let mut total = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|_| message())? {
            total = total.checked_add(chunk.len() as u64).ok_or_else(message)?;
            if total > MAX_DOWNLOAD {
                return Err("Web素材は512MB以下にしてください".into());
            }
            digest.update(&chunk);
            file.write_all(&chunk).map_err(|_| message())?;
        }
        if total == 0 {
            return Err(message());
        }
        file.sync_all().map_err(|_| message())?;
        let asset = DownloadedAsset {
            file: format!("{id}/{file_name}"),
            hash: format!("{:x}", digest.finalize()),
            bytes: total,
            source_url: public_copy(&current),
            source_page,
            license: license.to_string(),
        };
        let metadata = serde_json::to_vec_pretty(&asset).map_err(|_| message())?;
        std::fs::write(folder.join("source.json"), metadata).map_err(|_| message())?;
        Ok(asset)
    }
    .await;
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&folder);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_https_and_supported_names_are_accepted() {
        assert!(parse_https("https://assets.example/model.glb?token=secret").is_ok());
        assert!(parse_https("http://assets.example/model.glb").is_err());
        assert!(parse_https("https://user:secret@assets.example/model.glb").is_err());
        assert!(valid_filename("model-v2.glb"));
        assert!(valid_filename("bundle.zip"));
        assert!(!valid_filename("../model.glb"));
        assert!(!valid_filename("model.py"));
    }

    #[test]
    fn local_and_documentation_networks_are_rejected() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.0.1",
            "198.51.100.8",
            "::1",
            "fd00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!public_address(address.parse().unwrap()), "{address}");
        }
        assert!(public_address("8.8.8.8".parse().unwrap()));
        assert!(public_address("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn persisted_url_drops_query_credentials() {
        let url = parse_https("https://cdn.example/model.glb?signature=secret#part").unwrap();
        assert_eq!(public_copy(&url), "https://cdn.example/model.glb");
    }
}
