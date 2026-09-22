use serde_json::Value;
use std::collections::HashSet;

// AI proposals carry stable box IDs, never immutable source offsets. Resolve IDs
// against the current saved boxes in JS before applying the strict save validator.
pub fn validate_proposal(layout: &Value) -> Result<(), String> {
    let fail = || "Invalid lettering proposal or source identity".to_string();
    let mut geometry = layout.clone();
    let boxes = geometry
        .get_mut("boxes")
        .and_then(Value::as_array_mut)
        .ok_or_else(fail)?;
    let mut source_mode = None;
    for b in boxes {
        if b.get("sourceRefs").is_some() {
            return Err(fail());
        }
        if b["id"].as_str().is_some_and(|id| id.starts_with("custom:")) {
            if b.get("unit_id").is_some() {
                return Err(fail());
            }
            continue;
        }
        let id_only = b.get("unit_id").is_none();
        if b.get("text").is_some()
            || b[if id_only { "id" } else { "unit_id" }]
                .as_str()
                .is_none_or(|id| id.trim().is_empty())
            || source_mode.is_some_and(|mode| mode != id_only)
        {
            return Err(fail());
        }
        source_mode = Some(id_only);
        if id_only {
            // Temporary shape adapter only; neither output nor saved refs change.
            b["sourceRefs"] = serde_json::json!([]);
        }
    }
    validate(&geometry, None)
}

pub fn validate(layout: &Value, ids: Option<&Vec<&str>>) -> Result<(), String> {
    let fail = || "Invalid lettering geometry or source references".to_string();
    if !["caption", "balloons"].contains(&layout["mode"].as_str().unwrap_or(""))
        || layout
            .as_object()
            .is_none_or(|o| o.keys().any(|k| !["mode", "boxes"].contains(&k.as_str())))
    {
        return Err(fail());
    }
    let boxes = layout["boxes"].as_array().ok_or_else(fail)?;
    let is_custom = |b: &Value| b.get("unit_id").is_none() && b.get("sourceRefs").is_none();
    if boxes.len() > 1000
        || ids.is_some_and(|ids| ids.len() != boxes.iter().filter(|b| !is_custom(b)).count())
    {
        return Err(fail());
    }
    let mut seen = HashSet::new();
    let mut source_index = 0;
    for b in boxes.iter() {
        let modern = b.get("sourceRefs").is_some();
        let custom = is_custom(b);
        let id = b[if modern || custom { "id" } else { "unit_id" }]
            .as_str()
            .ok_or_else(fail)?;
        if custom {
            if !id.starts_with("custom:")
                || b["text"]
                    .as_str()
                    .is_none_or(|text| text.trim().is_empty() || text.encode_utf16().count() > 4000)
            {
                return Err(fail());
            }
        } else {
            if b.get("text").is_some() || ids.is_some_and(|ids| ids[source_index] != id) {
                return Err(fail());
            }
            source_index += 1;
        }
        let key = format!(
            "{}:{id}",
            if custom {
                "custom"
            } else if modern {
                "ref"
            } else {
                "unit"
            }
        );
        if !seen.insert(key)
            || b.as_object().is_none_or(|o| {
                o.keys().any(|k| {
                    ![
                        "id",
                        "unit_id",
                        "sourceRefs",
                        "text",
                        "x",
                        "y",
                        "width",
                        "height",
                        "kind",
                        "shape",
                        "tail",
                        "fontSize",
                        "lineHeight",
                        "padding",
                        "locked",
                        "writingMode",
                        "fontFamily",
                    ]
                    .contains(&k.as_str())
                })
            })
        {
            return Err(fail());
        }
        if let Some(box_id) = b.get("id") {
            if !modern && !custom && box_id.as_str() != Some(format!("letter:{id}").as_str()) {
                return Err(fail());
            }
        }
        for (key, min, max) in [
            ("x", 0., 1.),
            ("y", 0., 1.),
            ("width", 0.08, 1.),
            ("height", 0.06, 1.),
        ] {
            if b[key].as_f64().is_none_or(|v| !(min..=max).contains(&v)) {
                return Err(fail());
            }
        }
        if b.get("writingMode")
            .is_some_and(|v| !["horizontal-tb", "vertical-rl"].contains(&v.as_str().unwrap_or("")))
            || b.get("fontFamily")
                .is_some_and(|v| !["gothic", "mincho"].contains(&v.as_str().unwrap_or("")))
        {
            return Err(fail());
        }
        if b["x"].as_f64().unwrap() + b["width"].as_f64().unwrap() > 1.00001
            || b["y"].as_f64().unwrap() + b["height"].as_f64().unwrap() > 1.00001
        {
            return Err(fail());
        }
        for (key, min, max) in [
            ("fontSize", 14., 72.),
            ("lineHeight", 1., 2.),
            ("padding", 0., 40.),
        ] {
            if let Some(v) = b.get(key) {
                if v.as_f64().is_none_or(|n| !(min..=max).contains(&n)) {
                    return Err(fail());
                }
            }
        }
        if b.get("kind").is_some_and(|v| {
            !["balloon", "thought", "narration", "plain"].contains(&v.as_str().unwrap_or(""))
        }) || b
            .get("shape")
            .is_some_and(|v| !["round", "rect", "ellipse"].contains(&v.as_str().unwrap_or("")))
            || b.get("locked").is_some_and(|v| !v.is_boolean())
        {
            return Err(fail());
        }
        let kind = b.get("kind").and_then(Value::as_str).unwrap_or("balloon");
        if (kind == "narration" && b.get("shape").is_some_and(|v| v.as_str() != Some("rect")))
            || ((kind == "thought" || kind == "narration")
                && b.get("tail").is_some_and(|v| !v.is_null()))
        {
            return Err(fail());
        }
        if let Some(t) = b.get("tail").filter(|v| !v.is_null()) {
            if t.as_array().is_none_or(|a| {
                a.len() != 2
                    || a.iter()
                        .any(|n| n.as_f64().is_none_or(|n| !(0.0..=1.0).contains(&n)))
            }) {
                return Err(fail());
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn source_id_proposals_do_not_relax_persistent_lettering_validation() {
        let v = json!({"mode":"balloons","boxes":[
            {"id":"box:source","x":0.1,"y":0.1,"width":0.4,"height":0.6,"writingMode":"vertical-rl","fontFamily":"mincho"},
            {"id":"custom:p:1","text":"放課後","x":0.6,"y":0.1,"width":0.3,"height":0.2,"kind":"narration","shape":"rect"}
        ]});
        let original = v.clone();
        assert!(validate_proposal(&v).is_ok());
        assert!(validate_proposal(&json!(null)).is_err());
        assert!(validate_proposal(&json!("invalid")).is_err());
        assert_eq!(v, original);
        assert!(validate(&v, None).is_err());
        for (key, value) in [
            ("sourceRefs", json!([])),
            ("text", json!("原文を書き換え")),
            ("fontFamily", json!("external")),
            ("writingMode", json!("sideways")),
            ("id", json!("")),
        ] {
            let mut invalid = v.clone();
            invalid["boxes"][0][key] = value;
            assert!(validate_proposal(&invalid).is_err());
        }
        let mut mixed = v;
        mixed["boxes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"unit_id":"u","x":0.1,"y":0.1,"width":0.3,"height":0.2}));
        assert!(validate_proposal(&mixed).is_err());
    }
    #[test]
    fn typography_and_custom_narration_preserve_source_order() {
        let v = json!({"mode":"balloons","boxes":[
            {"id":"letter:u1","unit_id":"u1","x":0.1,"y":0.1,"width":0.3,"height":0.2,"writingMode":"vertical-rl","fontFamily":"mincho"},
            {"id":"custom:p:1","text":"放課後","x":0.1,"y":0.4,"width":0.3,"height":0.2,"kind":"narration","shape":"rect"},
            {"id":"letter:u2","unit_id":"u2","x":0.1,"y":0.7,"width":0.3,"height":0.2}
        ]});
        assert!(validate(&v, Some(&vec!["u1", "u2"])).is_ok());
        assert!(validate(&v, Some(&vec!["u2", "u1"])).is_err());
        for (index, key, value) in [
            (0, "fontFamily", json!("untrusted-font")),
            (0, "writingMode", json!("sideways-lr")),
            (0, "text", json!("replaced source")),
            (1, "text", json!(" ")),
            (1, "id", json!("not-custom")),
        ] {
            let mut invalid = v.clone();
            invalid["boxes"][index][key] = value;
            assert!(validate(&invalid, Some(&vec!["u1", "u2"])).is_err());
        }
    }
    #[test]
    fn preserves_units_and_rejects_bad_geometry_and_style() {
        let v = json!({"mode":"balloons","boxes":[{"id":"letter:u","unit_id":"u","x":0.1,"y":0.1,"width":0.4,"height":0.3,"shape":"ellipse","fontSize":24,"locked":true}]});
        assert!(validate(&v, Some(&vec!["u"])).is_ok());
        assert!(validate(&v, Some(&vec!["other"])).is_err());
        for (key, value) in [
            ("fontSize", json!(2)),
            ("x", json!(0.9)),
            ("tail", json!([2, 0])),
            ("text", json!("rewritten")),
        ] {
            let mut invalid = v.clone();
            invalid["boxes"][0][key] = value;
            assert!(validate(&invalid, None).is_err());
        }
    }
    #[test]
    fn validates_lettering_kinds_and_legacy_plain() {
        let v = json!({"mode":"balloons","boxes":[
            {"id":"letter:u1","unit_id":"u1","x":0.1,"y":0.1,"width":0.3,"height":0.2,"kind":"thought","tail":null},
            {"id":"letter:u2","unit_id":"u2","x":0.1,"y":0.4,"width":0.3,"height":0.2,"kind":"narration","shape":"rect","tail":null},
            {"id":"letter:u3","unit_id":"u3","x":0.1,"y":0.7,"width":0.3,"height":0.2,"kind":"balloon","shape":"round","tail":[0.5,0.5]}
        ]});
        assert!(validate(&v, Some(&vec!["u1", "u2", "u3"])).is_ok());
        let mut invalid = v.clone();
        invalid["boxes"][0]["tail"] = json!([0.5, 0.5]);
        assert!(validate(&invalid, None).is_err());
        invalid = v.clone();
        invalid["boxes"][1]["shape"] = json!("ellipse");
        assert!(validate(&invalid, None).is_err());
        invalid = v;
        invalid["boxes"][0]["kind"] = json!("unknown");
        assert!(validate(&invalid, None).is_err());
    }
}
