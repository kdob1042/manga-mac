use serde_json::Value;
use std::collections::HashSet;
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
    if boxes.len() > 1000 || ids.is_some_and(|ids| ids.len() != boxes.len()) {
        return Err(fail());
    }
    let mut seen = HashSet::new();
    for (i, b) in boxes.iter().enumerate() {
        let modern = b.get("sourceRefs").is_some();
        let id = b[if modern { "id" } else { "unit_id" }]
            .as_str()
            .ok_or_else(fail)?;
        if !seen.insert(id)
            || ids.is_some_and(|ids| ids[i] != id)
            || b.as_object().is_none_or(|o| {
                o.keys().any(|k| {
                    ![
                        "id",
                        "unit_id",
                        "sourceRefs",
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
                    ]
                    .contains(&k.as_str())
                })
            })
        {
            return Err(fail());
        }
        if let Some(box_id) = b.get("id") {
            if !modern && box_id.as_str() != Some(format!("letter:{id}").as_str()) {
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
            !["balloon", "thought", "narration", "plain"]
                .contains(&v.as_str().unwrap_or(""))
        }) || b.get("shape")
            .is_some_and(|v| !["round", "rect", "ellipse"].contains(&v.as_str().unwrap_or("")))
            || b.get("locked").is_some_and(|v| !v.is_boolean())
        {
            return Err(fail());
        }
        let kind = b.get("kind").and_then(Value::as_str).unwrap_or("balloon");
        if (kind == "narration"
            && b.get("shape").is_some_and(|v| v.as_str() != Some("rect")))
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
