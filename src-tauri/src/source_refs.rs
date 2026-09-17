use serde_json::{json, Value};
use sha2::{Digest, Sha256};
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub fn resolve<'a>(project: &'a Value, r: &Value) -> Result<&'a str, String> {
    if !r["snapshotId"].is_string() || !r["sceneId"].is_string() {
        return Err("Invalid source identity".into());
    }
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
    let mut snapshot_ids = std::collections::HashSet::new();
    for snapshot in project["snapshots"].as_array().ok_or("Missing snapshots")? {
        if !snapshot_ids.insert(snapshot["id"].as_str().ok_or("Missing snapshot ID")?) {
            return Err("Duplicate snapshot ID".into());
        }
        let mut scene_ids = std::collections::HashSet::new();
        for scene in snapshot["scenes"].as_array().ok_or("Missing scenes")? {
            if !scene_ids.insert(scene["id"].as_str().ok_or("Missing scene ID")?) {
                return Err("Duplicate scene ID".into());
            }
            let text = scene["text"].as_str().ok_or("Invalid source text")?;
            if scene["sourceHash"].as_str() != Some(hash(text).as_str()) {
                return Err("Immutable source hash mismatch".into());
            }
        }
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
    panels(project, project)?;
    validate_application(project)
}
fn intersects(a: &Value, b: &Value) -> bool {
    a["snapshotId"] == b["snapshotId"]
        && a["sceneId"] == b["sceneId"]
        && a["startCp"].as_u64() < b["endCp"].as_u64()
        && b["startCp"].as_u64() < a["endCp"].as_u64()
}
pub(super) fn covers(target: &Value, refs: &[&Value]) -> bool {
    let mut intervals: Vec<_> = refs
        .iter()
        .filter(|r| intersects(target, r))
        .map(|r| {
            (
                r["startCp"]
                    .as_u64()
                    .unwrap()
                    .max(target["startCp"].as_u64().unwrap()),
                r["endCp"]
                    .as_u64()
                    .unwrap()
                    .min(target["endCp"].as_u64().unwrap()),
            )
        })
        .collect();
    intervals.sort();
    let mut end = target["startCp"].as_u64().unwrap();
    for (a, b) in intervals {
        if a > end {
            return false;
        }
        end = end.max(b);
    }
    end == target["endCp"].as_u64().unwrap()
}
fn ordered_coverage(expected: &[&Value], actual: &[&Value]) -> bool {
    let (mut i, mut j) = (0, 0);
    let mut a = expected.first().and_then(|r| r["startCp"].as_u64());
    let mut b = actual.first().and_then(|r| r["startCp"].as_u64());
    while i < expected.len() && j < actual.len() {
        let e = expected[i];
        let r = actual[j];
        if e["snapshotId"] != r["snapshotId"] || e["sceneId"] != r["sceneId"] || a != b {
            return false;
        }
        let end = e["endCp"]
            .as_u64()
            .unwrap()
            .min(r["endCp"].as_u64().unwrap());
        a = Some(end);
        b = Some(end);
        if Some(end) == e["endCp"].as_u64() {
            i += 1;
            a = expected.get(i).and_then(|r| r["startCp"].as_u64());
        }
        if Some(end) == r["endCp"].as_u64() {
            j += 1;
            b = actual.get(j).and_then(|r| r["startCp"].as_u64());
        }
    }
    i == expected.len() && j == actual.len()
}
pub fn validate_application(p: &Value) -> Result<(), String> {
    let units = p["sourceApplication"]["units"]
        .as_array()
        .ok_or("Missing applied units")?;
    if units.is_empty() {
        return Ok(());
    }
    let panels = p["panels"].as_array().ok_or("Missing panels")?;
    let placements: Vec<_> = p["layout"]["pages"]
        .as_array()
        .ok_or("Missing source layout")?
        .iter()
        .flat_map(|page| page["slots"].as_array().into_iter().flatten())
        .map(|s| &s["panelId"])
        .collect();
    let mut required = vec![];
    for (index, unit) in units.iter().enumerate() {
        if units[..index]
            .iter()
            .any(|u| intersects(&u["source"], &unit["source"]))
        {
            return Err("Overlapping applied units".into());
        }
        for r in unit["requiredText"]
            .as_array()
            .ok_or("Missing text policy")?
        {
            if !covers(r, &[&unit["source"]]) {
                return Err("Required text is outside its unit".into());
            }
            required.push(r);
        }
        let linked: Vec<_> = panels
            .iter()
            .filter(|panel| {
                panel["sourceRefs"]
                    .as_array()
                    .is_some_and(|rs| rs.iter().any(|r| intersects(r, &unit["source"])))
            })
            .collect();
        if linked.is_empty()
            || linked.iter().any(|panel| {
                panel["image"].is_null()
                    || panel["image"] == ""
                    || placements.iter().filter(|id| ***id == panel["id"]).count() != 1
            })
        {
            return Err("Applied artwork is incomplete or not uniquely placed".into());
        }
        let visual: Vec<_> = linked
            .iter()
            .flat_map(|panel| panel["sourceRefs"].as_array().into_iter().flatten())
            .collect();
        if !covers(&unit["source"], &visual) {
            return Err("Missing primary source coverage".into());
        }
    }
    let shown: Vec<_> = placements
        .iter()
        .filter_map(|id| panels.iter().find(|p| p["id"] == **id))
        .flat_map(|panel| panel["lettering"]["boxes"].as_array().into_iter().flatten())
        .flat_map(|b| b["sourceRefs"].as_array().into_iter().flatten())
        .filter(|r| units.iter().any(|u| intersects(r, &u["source"])))
        .collect();
    if !ordered_coverage(&required, &shown) {
        return Err("Required lettering is missing, duplicated or out of order".into());
    }
    Ok(())
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
