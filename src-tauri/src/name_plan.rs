//! Native validation for planned text policy. Rendering and geometry compilation stay in JS.
use super::resolve;
use serde_json::{json, Value};
use std::collections::HashSet;
type Result<T> = std::result::Result<T, String>;
const FORMAT: &str = "manga-mac/name-plan/v2";
fn list<'a>(v: &'a Value, label: &str) -> Result<&'a Vec<Value>> {
    v.as_array().ok_or_else(|| format!("Invalid name plan {label}"))
}
fn schema_check(value: &Value, schema: &Value, root: &Value, depth: usize) -> Result<()> {
    if depth > 40 {
        return Err("Name plan nesting limit".into());
    }
    if let Some(reference) = schema["$ref"].as_str() {
        if reference != "#/$defs/tree" {
            return Err("Unknown name schema reference".into());
        }
        return schema_check(value, &root["$defs"]["tree"], root, depth + 1);
    }
    if let Some(choices) = schema["anyOf"].as_array() {
        return if choices
            .iter()
            .any(|choice| schema_check(value, choice, root, depth + 1).is_ok())
        {
            Ok(())
        } else {
            Err("Name schema choice mismatch".into())
        };
    }
    if schema.get("const").is_some_and(|constant| value != constant)
        || schema["enum"]
            .as_array()
            .is_some_and(|values| !values.contains(value))
    {
        return Err("Unsupported name schema value".into());
    }
    match schema["type"].as_str() {
        Some("null") if !value.is_null() => return Err("Expected null".into()),
        Some("string") => {
            let text = value.as_str().ok_or("Expected name string")?;
            let length = text.encode_utf16().count() as u64;
            if length > schema["maxLength"].as_u64().unwrap_or(u64::MAX)
                || (schema["minLength"].as_u64().unwrap_or(0) > 0
                    && text
                        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                        .is_empty())
            {
                return Err("Name string length violation".into());
            }
            if let Some(pattern) = schema["pattern"].as_str() {
                let valid = match pattern {
                    "^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$" => {
                        !text.is_empty()
                            && text.len() <= 160
                            && text.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric())
                            && text
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b":_-".contains(&c))
                    }
                    "^[0-9a-f]{40}$" => {
                        text.len() == 40
                            && text
                                .bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    }
                    "^[0-9a-f]{64}$" => {
                        text.len() == 64
                            && text
                                .bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    }
                    _ => false,
                };
                if !valid {
                    return Err("Name identifier pattern mismatch".into());
                }
            }
        }
        Some("number") => {
            let n = value.as_f64().ok_or("Expected name number")?;
            if !n.is_finite()
                || schema["minimum"].as_f64().is_some_and(|min| n < min)
                || schema["maximum"].as_f64().is_some_and(|max| n > max)
                || schema["exclusiveMinimum"].as_f64().is_some_and(|min| n <= min)
            {
                return Err("Name number range violation".into());
            }
        }
        Some("array") => {
            let items = list(value, "array")?;
            if items.len() < schema["minItems"].as_u64().unwrap_or(0) as usize
                || items.len() > schema["maxItems"].as_u64().unwrap_or(u64::MAX) as usize
            {
                return Err("Name array limit".into());
            }
            for item in items {
                schema_check(item, &schema["items"], root, depth + 1)?;
            }
        }
        Some("object") => {
            let object = value.as_object().ok_or("Expected name object")?;
            let properties = schema["properties"]
                .as_object()
                .ok_or("Invalid name schema")?;
            if object.keys().any(|key| !properties.contains_key(key)) {
                return Err("Unknown name field".into());
            }
            for key in schema["required"].as_array().into_iter().flatten() {
                if !object.contains_key(key.as_str().ok_or("Invalid name schema key")?) {
                    return Err("Missing name field".into());
                }
            }
            for (key, item) in object {
                schema_check(item, &properties[key], root, depth + 1)?;
            }
        }
        _ => (),
    }
    Ok(())
}
fn intersects(a: &Value, b: &Value) -> bool {
    a["snapshotId"] == b["snapshotId"]
        && a["sceneId"] == b["sceneId"]
        && a["startCp"].as_u64() < b["endCp"].as_u64()
        && b["startCp"].as_u64() < a["endCp"].as_u64()
}
fn clipped(source: &Value, target: &Value) -> Value {
    json!({"snapshotId":source["snapshotId"],"sceneId":source["sceneId"],"startCp":source["startCp"].as_u64().unwrap().max(target["startCp"].as_u64().unwrap()),"endCp":source["endCp"].as_u64().unwrap().min(target["endCp"].as_u64().unwrap())})
}
fn ordered(expected: &[&Value], actual: &[&Value]) -> bool {
    super::ordered_coverage(expected, actual)
}
fn text_is_reference(text: &str) -> bool {
    let text = text.trim();
    text.is_empty()
        || text.starts_with("![") && text.ends_with(')')
        || text.starts_with("<!--") && text.ends_with("-->")
        || ["**", "__", "`", "["].contains(&text)
        || text.starts_with("](") && text.ends_with(')')
}
fn quoted_ranges(text: &str) -> Vec<(usize, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let mut result = vec![];
    let mut stack = vec![];
    let mut start = 0;
    let mut i = 0;
    while i < chars.len() {
        // Image alt and HTML comments are not dialogue.
        if chars[i..].starts_with(&['!', '[']) {
            if let Some(end) = chars[i..].iter().position(|c| *c == ')') {
                i += end + 1;
                continue;
            }
        }
        if chars[i..].starts_with(&['<', '!', '-', '-']) {
            if let Some(end) = chars[i..].windows(3).position(|w| w == ['-', '-', '>']) {
                i += end + 3;
                continue;
            }
        }
        if let Some(close) = match chars[i] {
            '「' => Some('」'),
            '『' => Some('』'),
            _ => None,
        } {
            if stack.is_empty() {
                start = i;
            }
            stack.push(close);
        } else if stack.last() == Some(&chars[i]) {
            stack.pop();
            if stack.is_empty() {
                result.push((start, i + 1));
            }
        }
        i += 1;
    }
    result
}
fn state(project: &Value, current: &Value, schema: &Value) -> Result<()> {
    let name = &current["namePlan"];
    if name["format"] != FORMAT {
        return Ok(());
    }
    let file = &name["file"];
    if file.to_string().len() > 4 * 1024 * 1024 {
        return Err("Name file exceeds 4MiB".into());
    }
    schema_check(file, schema, schema, 0)?;
    let policy = list(&name["sourcePolicy"], "source policy")?;
    if policy.len() > 12000 {
        return Err("Name source policy limit".into());
    }
    let snapshot = project["snapshots"]
        .as_array()
        .and_then(|ss| ss.iter().find(|s| s["id"] == name["snapshotId"]))
        .ok_or("Missing name snapshot")?;
    if file["source"]["repo"] != snapshot["repo"]
        || &file["source"]["workId"] != snapshot.get("workId").unwrap_or(&project["workId"])
    {
        return Err("Different name source work".into());
    }
    let mut scenes = HashSet::new();
    for declared in list(&file["source"]["scenes"], "scenes")? {
        if !scenes.insert(declared["id"].as_str().ok_or("Invalid name scene")?) {
            return Err("Duplicate name scene".into());
        }
        let scene = snapshot["scenes"]
            .as_array()
            .and_then(|ss| ss.iter().find(|s| s["id"] == declared["id"]))
            .ok_or("Missing name scene")?;
        if scene["sourceHash"] != declared["sha256"] {
            return Err("Name source hash mismatch".into());
        }
    }
    for (i, entry) in policy.iter().enumerate() {
        let source = &entry["source"];
        let text = resolve(project, source)?;
        if policy[..i]
            .iter()
            .any(|old| intersects(&old["source"], source))
        {
            return Err("Overlapping name policy".into());
        }
        let required = list(&entry["requiredText"], "required text")?;
        for r in required {
            resolve(project, r)?;
        }
        let is_printed = matches!(
            entry["presentation"].as_str(),
            Some("dialogue" | "thought" | "narration")
        );
        if is_printed && required != &vec![source.clone()] || !is_printed && !required.is_empty() {
            return Err("Name text policy mismatch".into());
        }
        if entry["presentation"] == "reference" && !text_is_reference(text) {
            return Err("Narrative cannot be discarded as markup".into());
        }
        if !is_printed && entry["presentation"] != "reference" {
            let scene = project["snapshots"]
                .as_array()
                .and_then(|ss| ss.iter().find(|s| s["id"] == source["snapshotId"]))
                .and_then(|s| s["scenes"].as_array())
                .and_then(|ss| ss.iter().find(|s| s["id"] == source["sceneId"]))
                .ok_or("Missing name source")?;
            let start = source["startCp"].as_u64().unwrap() as usize;
            let end = source["endCp"].as_u64().unwrap() as usize;
            if quoted_ranges(scene["text"].as_str().ok_or("Missing source text")?)
                .iter()
                .any(|(a, b)| start < *b && *a < end)
            {
                return Err("Quoted source text cannot be silently omitted".into());
            }
        }
    }
    let selected = list(&file["source"]["selectedAtomIds"], "selection")?;
    let coverage = list(&file["plan"]["coverage"], "coverage")?;
    if selected
        .iter()
        .ne(coverage.iter().map(|entry| &entry["atomId"]))
    {
        return Err("Name selection order mismatch".into());
    }
    let mut selected_unique = HashSet::new();
    let mut selected_policy = vec![];
    for entry in coverage {
        if !selected_unique.insert(entry["atomId"].as_str().ok_or("Invalid atom ID")?) {
            return Err("Duplicate name atom".into());
        }
        let matches: Vec<_> = policy
            .iter()
            .filter(|p| p["atomId"] == entry["atomId"] && p["source"]["snapshotId"] == name["snapshotId"])
            .collect();
        if matches.len() != 1 || matches[0]["presentation"] != entry["presentation"] {
            return Err("Name file and bound policy disagree".into());
        }
        selected_policy.push(matches[0]);
    }
    let panel_ids = list(&name["panelIds"], "panel IDs")?;
    let panels = list(&current["panels"], "panels")?;
    if name["status"] == "stale"
        && panel_ids
            .iter()
            .any(|id| !panels.iter().any(|p| p["id"] == *id))
    {
        return Ok(());
    }
    let target: Vec<_> = panel_ids
        .iter()
        .map(|id| {
            panels
                .iter()
                .find(|p| p["id"] == *id)
                .ok_or_else(|| "Missing name panel".to_string())
        })
        .collect::<Result<_>>()?;
    let expected: Vec<_> = selected_policy.iter().map(|p| &p["source"]).collect();
    let actual: Vec<_> = target
        .iter()
        .flat_map(|p| p["sourceRefs"].as_array().into_iter().flatten())
        .collect();
    if !ordered(&expected, &actual) {
        return Err("Name primary coverage mismatch".into());
    }
    let expected_text: Vec<_> = selected_policy
        .iter()
        .flat_map(|p| p["requiredText"].as_array().into_iter().flatten())
        .collect();
    let actual_text: Vec<_> = target
        .iter()
        .flat_map(|p| p["requiredText"].as_array().into_iter().flatten())
        .collect();
    if !ordered(&expected_text, &actual_text) {
        return Err("Name required text mismatch".into());
    }
    for panel in &target {
        if panel["namePlanVersion"] != 2 {
            return Err("Name panel version mismatch".into());
        }
        for r in list(&panel["requiredText"], "panel text")? {
            resolve(project, r)?;
        }
        let slots: Vec<_> = current["layout"]["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|page| page["slots"].as_array().into_iter().flatten())
            .filter(|slot| slot["panelId"] == panel["id"])
            .collect();
        if slots.len() != 1 {
            return Err("Name panel placement mismatch".into());
        }
        if let Some(locked) =
            name["locks"]["panelPoints"].get(panel["id"].as_str().ok_or("Invalid panel ID")?)
        {
            if *locked != slots[0]["points"] {
                return Err("Locked name panel changed".into());
            }
        }
    }
    if let Some(locks) = name["locks"]["pages"].as_object() {
        for (id, locked) in locks {
            if current["layout"]["pages"].as_array().and_then(|ps| {
                ps.iter()
                    .find(|p| p["id"].as_str() == Some(id.as_str()))
            }) != Some(locked)
            {
                return Err("Locked name page changed".into());
            }
        }
    }
    // Completed units must use precisely the approved policy; unresolved partial units stay incomplete.
    for unit in current["sourceApplication"]["units"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let entries: Vec<_> = policy
            .iter()
            .filter(|entry| intersects(&entry["source"], &unit["source"]))
            .collect();
        let coverage: Vec<_> = entries
            .iter()
            .map(|entry| clipped(&entry["source"], &unit["source"]))
            .collect();
        if ordered(&[&unit["source"]], &coverage.iter().collect::<Vec<_>>()) {
            let required: Vec<_> = entries
                .iter()
                .flat_map(|entry| entry["requiredText"].as_array().into_iter().flatten())
                .filter(|r| intersects(r, &unit["source"]))
                .map(|r| clipped(r, &unit["source"]))
                .collect();
            if required != *list(&unit["requiredText"], "applied text")? {
                return Err("Applied text differs from the approved name policy".into());
            }
        }
    }
    Ok(())
}
pub(super) fn validate(project: &Value) -> Result<()> {
    let schema: Value =
        serde_json::from_str(include_str!("../../contracts/name-plan/schema.json"))
            .map_err(|e| e.to_string())?;
    let mut pending = vec![(project, 0)];
    while let Some((current, depth)) = pending.pop() {
        if depth > 64 {
            return Err("Name history nesting limit".into());
        }
        state(project, current, &schema)?;
        for key in ["history", "editRedo"] {
            for entry in current[key].as_array().into_iter().flatten() {
                pending.push((entry, depth + 1));
            }
        }
        if let Some(after) = current.get("after") {
            pending.push((after, depth + 1));
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::super::super::{hash, load, save_checked, tests::setup};
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/name-plan-v2-project.json")).unwrap()
    }
    #[test]
    fn bound_name_policy_is_validated_on_native_save() {
        validate(&fixture()).unwrap();
    }
    #[test]
    fn missing_dialogue_is_rejected() {
        let mut p = fixture();
        let i = p["namePlan"]["sourcePolicy"]
            .as_array()
            .unwrap()
            .iter()
            .position(|e| e["presentation"] == "dialogue")
            .unwrap();
        p["namePlan"]["sourcePolicy"][i]["requiredText"] = json!([]);
        assert!(validate(&p).is_err());
    }
    #[test]
    fn unknown_file_fields_are_rejected() {
        let mut p = fixture();
        p["namePlan"]["file"]["credential"] = json!("not-allowed");
        assert!(validate(&p).is_err());
    }
    #[test]
    fn quote_detection_excludes_image_alt() {
        assert_eq!(
            quoted_ranges("地の文「台詞😀」![「画像」](x.png)"),
            vec![(3, 8)]
        );
    }
    #[test]
    fn scalar_range_mutation_is_rejected() {
        let mut p = fixture();
        p["panels"][0]["sourceRefs"][0]["endCp"] = json!(99999);
        assert!(validate(&p).is_err());
    }
    #[test]
    fn absent_commit_is_allowed_but_invalid_commit_is_rejected() {
        let mut p = fixture();
        p["namePlan"]["file"]["source"]
            .as_object_mut()
            .unwrap()
            .remove("commit");
        validate(&p).unwrap();
        p["namePlan"]["file"]["source"]["commit"] = json!("invalid");
        assert!(validate(&p).is_err());
    }
    #[test]
    fn storyboard_v2_roundtrips_through_checked_sqlite_save() {
        let (mut db, root) = setup();
        let p: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/name-plan-v2-project.json"))
                .unwrap();
        save_checked(&mut db, &root, &p.to_string()).unwrap();
        let raw = load(&db, &root).unwrap().unwrap();
        let restored: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(restored["namePlan"], p["namePlan"]);
        assert_eq!(restored["panels"], p["panels"]);
        assert_eq!(restored["layout"], p["layout"]);
        let mut bad = restored.clone();
        bad["panels"][1]["requiredText"] = json!([]);
        assert!(save_checked(&mut db, &root, &bad.to_string()).is_err());
        assert_eq!(load(&db, &root).unwrap().unwrap(), raw);
        save_checked(&mut db, &root, &restored.to_string()).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn repository_name_without_commit_preserves_retrieval_receipt_on_save() {
        let (mut db, root) = setup();
        let mut p: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/name-plan-v2-project.json"))
                .unwrap();
        p["namePlan"]["file"]["source"]
            .as_object_mut()
            .unwrap()
            .remove("commit");
        p["namePlan"]["fileHash"] = json!(hash(p["namePlan"]["file"].to_string().as_bytes()));
        p["jobs"].as_array_mut().unwrap().push(json!({
            "id": "repository-name", "kind": "name_plan", "status": "complete",
            "source_revision": "snap", "repositoryPlan": {
                "repo": "fixture/stories", "commit": "a".repeat(40),
                "path": "works/example/manga/P01/name-plan.json", "episodeId": "P01"
            }
        }));
        save_checked(&mut db, &root, &p.to_string()).unwrap();
        let raw = load(&db, &root).unwrap().unwrap();
        let restored: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(restored["namePlan"], p["namePlan"]);
        assert_eq!(restored["jobs"], p["jobs"]);
        assert!(restored["namePlan"]["file"]["source"].get("commit").is_none());
        let mut bad = restored.clone();
        bad["namePlan"]["file"]["source"]["commit"] = json!("not-a-commit");
        assert!(save_checked(&mut db, &root, &bad.to_string()).is_err());
        assert_eq!(load(&db, &root).unwrap().unwrap(), raw);
        std::fs::remove_dir_all(root).unwrap();
    }
}
