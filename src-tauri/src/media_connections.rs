//! In-memory credentials for image/video adapters. Registration never performs network I/O.
//! Only opaque IDs cross into projects; secrets have no Debug/Serialize implementation.
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct Connections {
    entries: Mutex<HashMap<String, Arc<Connection>>>,
}
fn failure() -> String {
    "画像・動画の接続を取得できません".into()
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
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
// Ephemeral image/video credentials; no Debug/Serialize.
pub struct Connection {
    pub credential: String,
    pub max_credits: u64,
    pub provider: String,
    pub model: String,
    pub adapter_id: String,
}
impl Connections {
    pub fn register(
        &self,
        input: Registration,
        provider: String,
        model: String,
        adapter_id: String,
    ) -> Result<String, String> {
        if !input.approved
            || !(1..=6000).contains(&input.max_credits)
            || input.credential.trim().is_empty()
            || input.credential.len() > 4096
            || input.credential.chars().any(char::is_control)
        {
            return Err("送信先・モデル・予算を承認し、APIキーを入力してください".into());
        }
        let mut entries = self.entries.lock().map_err(|_| failure())?;
        if entries.len() >= 8 {
            return Err("不要な画像・動画接続を解除してください".into());
        }
        let id = id();
        entries.insert(
            id.clone(),
            Arc::new(Connection {
                credential: input.credential,
                max_credits: input.max_credits,
                provider,
                model,
                adapter_id,
            }),
        );
        Ok(id)
    }
    pub fn reuse(
        &self,
        source_id: &str,
        approved: bool,
        provider: String,
        model: String,
        adapter_id: String,
    ) -> Result<String, String> {
        if !approved {
            return Err("追加する動画モデルの送信先・費用を承認してください".into());
        }
        let mut entries = self.entries.lock().map_err(|_| failure())?;
        let source = entries
            .get(source_id)
            .cloned()
            .ok_or("再利用するRunway接続がありません")?;
        if source.provider != provider || source.adapter_id != adapter_id {
            return Err("別providerの資格情報を動画モデルへ流用できません".into());
        }
        if let Some((id, _)) = entries.iter().find(|(_, value)| {
            value.provider == provider
                && value.model == model
                && value.adapter_id == adapter_id
                && value.credential == source.credential
                && value.max_credits == source.max_credits
        }) {
            return Ok(id.clone());
        }
        if entries.len() >= 8 {
            return Err("不要な画像・動画接続を解除してください".into());
        }
        let id = id();
        entries.insert(
            id.clone(),
            Arc::new(Connection {
                credential: source.credential.clone(),
                max_credits: source.max_credits,
                provider,
                model,
                adapter_id,
            }),
        );
        Ok(id)
    }

    pub fn get(&self, id: &str) -> Result<Arc<Connection>, String> {
        self.entries
            .lock()
            .map_err(|_| failure())?
            .get(id)
            .cloned()
            .ok_or("画像・動画の接続を登録してください".into())
    }
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.entries.lock().map_err(|_| failure())?.remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_is_local_and_reuse_cannot_cross_provider_or_adapter() {
        let connections = Connections::default();
        let registration = || Registration {
            credential: "fixture-key".into(),
            max_credits: 100,
            approved: true,
            provider: None,
            model: None,
            adapter_id: None,
        };
        let id = connections
            .register(
                registration(),
                "runway".into(),
                "gen4.5".into(),
                "runway".into(),
            )
            .unwrap();
        assert_eq!(connections.get(&id).unwrap().model, "gen4.5");
        for (provider, adapter) in [("openai", "openai-image"), ("runway", "runway-image")] {
            assert!(connections
                .reuse(&id, true, provider.into(), "other".into(), adapter.into())
                .is_err());
        }
        assert!(connections
            .reuse(
                &id,
                false,
                "runway".into(),
                "gen4_turbo".into(),
                "runway".into()
            )
            .is_err());
        let reused = connections
            .reuse(
                &id,
                true,
                "runway".into(),
                "gen4_turbo".into(),
                "runway".into(),
            )
            .unwrap();
        assert_ne!(id, reused);
        assert_eq!(connections.get(&reused).unwrap().credential, "fixture-key");
        connections.remove(&id).unwrap();
        assert!(connections.get(&id).is_err());
        assert!(connections.get(&reused).is_ok());
        let mut invalid = registration();
        invalid.credential = "fixture\nkey".into();
        assert!(connections
            .register(invalid, "runway".into(), "gen4.5".into(), "runway".into())
            .is_err());
    }
}
