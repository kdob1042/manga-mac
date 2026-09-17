use serde_json::Value;
use std::collections::HashSet;

pub fn validate(project: &Value) -> Result<(), String> {
    validate_scope(project.get("draftScope"), project)?;
    if let Some(history) = project["history"].as_array() {
        let mut checkpoints = HashSet::new();
        for entry in history.iter().filter(|h| h["draftCheckpoint"] == true) {
            let id = entry["id"].as_str().ok_or("Missing draft checkpoint ID")?;
            if id.is_empty() || !checkpoints.insert(id) {
                return Err("Duplicate draft checkpoint".into());
            }
            let panels = entry["panels"].as_array().ok_or("Missing draft panels")?;
            let ids = panels
                .iter()
                .map(|p| p["id"].as_str().ok_or("Missing panel ID"))
                .collect::<Result<HashSet<_>, _>>()?;
            super::layout::validate(&entry["layout"], Some(&ids))?;
            validate_scope(entry.get("draftScope"), project)?;
            for panel in panels {
                if let Some(lettering) = panel.get("lettering") {
                    let units = panel["unitIds"]
                        .as_array()
                        .ok_or("Missing draft units")?
                        .iter()
                        .map(|v| v.as_str().ok_or("Invalid draft unit"))
                        .collect::<Result<Vec<_>, _>>()?;
                    super::lettering::validate(lettering, Some(&units))?;
                }
            }
        }
    }
    Ok(())
}

fn validate_scope(scope: Option<&Value>, project: &Value) -> Result<(), String> {
    let Some(scope) = scope.filter(|s| !s.is_null()) else {
        return Ok(());
    };
    if scope["id"].as_str().is_none_or(str::is_empty) {
        return Err("Invalid draft ID".into());
    }
    let source = project["snapshots"]
        .as_array()
        .ok_or("Missing sources")?
        .iter()
        .find(|s| s["id"].is_string() && s["id"] == scope["snapshotId"])
        .ok_or("Unknown draft source")?;
    let scenes = source["scenes"].as_array().ok_or("Missing source scenes")?;
    let selected = scope["sceneIds"].as_array().ok_or("Missing draft scenes")?;
    let mut ids = HashSet::new();
    if selected.is_empty()
        || selected.iter().any(|id| {
            !id.is_string() || !ids.insert(id.as_str()) || !scenes.iter().any(|s| s["id"] == *id)
        })
    {
        return Err("Invalid draft scene selection".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn scope_requires_existing_source_and_unique_nonempty_scenes() {
        let mut p = json!({"snapshots":[{"id":"s","scenes":[{"id":"a"}]}],"draftScope":{"id":"draft","snapshotId":"s","sceneIds":["a"]}});
        assert!(validate(&p).is_ok());
        for ids in [json!([]), json!(["a", "a"]), json!(["other"])] {
            p["draftScope"]["sceneIds"] = ids;
            assert!(validate(&p).is_err());
        }
    }
}
