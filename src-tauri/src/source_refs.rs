use serde_json::{json, Value};
use sha2::{Digest, Sha256};
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub fn resolve<'a>(project: &'a Value, r: &Value) -> Result<&'a str, String> {
    let snapshot = project["snapshots"]
        .as_array()
        .and_then(|ss| ss.iter().find(|s| s["id"] == r["snapshotId"]))
        .ok_or("Missing source snapshot")?;
    let scene = snapshot["scenes"]
        .as_array()
        .and_then(|ss| ss.iter().find(|s| s["id"] == r["sceneId"]))
        .ok_or("Missing source scene")?;
    let text = scene["text"].as_str().ok_or("Invalid source text")?;
    if scene["sourceHash"].as_str() != Some(hash(text).as_str()) {
        return Err("Immutable source hash mismatch".into());
    }
    let start = r["startCp"].as_u64().ok_or("Invalid scalar offset")? as usize;
    let end = r["endCp"].as_u64().ok_or("Invalid scalar offset")? as usize;
    let mut positions: Vec<_> = text.char_indices().map(|(i, _)| i).collect();
    positions.push(text.len());
    if start >= end || end >= positions.len() {
        return Err("Invalid scalar range".into());
    }
    Ok(&text[positions[start]..positions[end]])
}
pub fn validate(project: &Value) -> Result<(), String> {
    if project["version"].as_u64().unwrap_or(0) < 5 {
        return Ok(());
    }
    let application = project
        .get("sourceApplication")
        .ok_or("Missing source application")?;
    if application["version"] != 1 || !application["units"].is_array() {
        return Err("Invalid source application".into());
    }
    let mut ids = std::collections::HashSet::new();
    for unit in application["units"].as_array().unwrap() {
        if !ids.insert(unit["id"].as_str().ok_or("Missing applied unit ID")?) {
            return Err("Duplicate applied unit ID".into());
        }
        resolve(project, &unit["source"])?;
        for r in unit["requiredText"]
            .as_array()
            .ok_or("Missing text policy")?
        {
            resolve(project, r)?;
        }
    }
    fn panels(project: &Value, state: &Value) -> Result<(), String> {
        for p in state["panels"].as_array().into_iter().flatten() {
            if let Some(refs) = p.get("sourceRefs") {
                for r in refs.as_array().ok_or("Invalid source refs")? {
                    resolve(project, r)?;
                }
            }
            for r in p["contextRefs"].as_array().into_iter().flatten() {
                resolve(project, r)?;
            }
            let mut ids = std::collections::HashSet::new();
            for b in p["lettering"]["boxes"].as_array().into_iter().flatten() {
                if b.get("sourceRefs").is_some() {
                    if !ids.insert(b["id"].as_str().ok_or("Missing box ID")?) {
                        return Err("Duplicate box ID".into());
                    }
                    for r in b["sourceRefs"].as_array().ok_or("Invalid text refs")? {
                        resolve(project, r)?;
                    }
                }
            }
        }
        for entry in state["history"].as_array().into_iter().flatten() {
            panels(project, entry)?;
        }
        for entry in state["editRedo"].as_array().into_iter().flatten() {
            panels(project, entry)?;
        }
        if let Some(after) = state.get("after") {
            panels(project, after)?;
        }
        Ok(())
    }
    panels(project, project)
}
pub fn token(project: &Value) -> String {
    let content = json!({"active":project["active"],"snapshots":project["snapshots"],"panels":project["panels"],"layout":project["layout"],"sourceApplication":project["sourceApplication"]});
    hash(&content.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_offsets_and_hashes_are_exact() {
        let text = "日本😀e\u{301}\r\n次行";
        let p = json!({"snapshots":[{"id":"s","scenes":[{"id":"scene","text":text,"sourceHash":hash(text)}]}]});
        let r = json!({"snapshotId":"s","sceneId":"scene","startCp":0,"endCp":3});
        assert_eq!(resolve(&p, &r).unwrap(), "日本😀");
        let mut bad = r;
        bad["endCp"] = json!(99);
        assert!(resolve(&p, &bad).is_err());
        let mut bad = p;
        bad["snapshots"][0]["scenes"][0]["text"] = json!("changed");
        assert!(resolve(
            &bad,
            &json!({"snapshotId":"s","sceneId":"scene","startCp":0,"endCp":1})
        )
        .is_err());
    }
    #[test]
    fn shared_scalar_fixture_matches_javascript() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/source-refs.json")).unwrap();
        let p = json!({"snapshots":[{"id":"old","scenes":[{"id":"s","text":fixture["text"],"sourceHash":fixture["sourceHash"]}]}]});
        for case in fixture["cases"].as_array().unwrap() {
            let r = json!({"snapshotId":"old","sceneId":"s","startCp":case["startCp"],"endCp":case["endCp"]});
            assert_eq!(resolve(&p, &r).unwrap(), case["text"].as_str().unwrap());
        }
    }
    #[test]
    fn token_ignores_job_progress_but_not_content() {
        let p = json!({"active":"s","panels":[],"jobs":[]});
        let mut updated = p.clone();
        updated["jobs"] = json!([{"status":"running"}]);
        assert_eq!(token(&p), token(&updated));
        updated["panels"] = json!([{"id":"p"}]);
        assert_ne!(token(&p), token(&updated));
    }
}
