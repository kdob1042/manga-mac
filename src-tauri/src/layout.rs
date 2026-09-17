//! Page geometry validation shared by persistence and the existing LLM router.
use serde_json::Value;
use std::collections::HashSet;
pub fn validate(layout: &Value, panel_ids: Option<&HashSet<&str>>) -> Result<(), String> {
    let fail = || "Invalid page layout".to_string();
    if layout["version"].as_u64() != Some(1) {
        return Err(fail());
    }
    if let Some(crops) = layout.get("imageCrops") {
        for crop in crops.as_object().ok_or_else(fail)?.values() {
            for (key, min, max) in [("zoom", 1.0, 8.0), ("x", 0.0, 1.0), ("y", 0.0, 1.0)] {
                let n = crop[key].as_f64().ok_or_else(fail)?;
                if !n.is_finite() || n < min || n > max {
                    return Err(fail());
                }
            }
        }
    }
    let pages = layout["pages"].as_array().ok_or_else(fail)?;
    if pages.len() > 1000 {
        return Err(fail());
    }
    let mut ids = HashSet::new();
    let mut assigned = HashSet::new();
    for page in pages {
        let id = page["id"].as_str().ok_or_else(fail)?;
        if id.is_empty() || !ids.insert(format!("page:{id}")) {
            return Err(fail());
        }
        let slots = page["slots"].as_array().ok_or_else(fail)?;
        if slots.len() > 16 {
            return Err(fail());
        }
        for slot in slots {
            let id = slot["id"].as_str().ok_or_else(fail)?;
            if id.is_empty() || !ids.insert(format!("slot:{id}")) {
                return Err(fail());
            }
            if !slot["panelId"].is_null() {
                let panel = slot["panelId"].as_str().ok_or_else(fail)?;
                if !assigned.insert(panel) || panel_ids.is_some_and(|known| !known.contains(panel))
                {
                    return Err(fail());
                }
            }
            let points = slot["points"].as_array().ok_or_else(fail)?;
            if points.len() != 4 {
                return Err(fail());
            }
            let mut quad = [[0.0_f64; 2]; 4];
            for (i, p) in points.iter().enumerate() {
                let pair = p.as_array().ok_or_else(fail)?;
                if pair.len() != 2 {
                    return Err(fail());
                }
                for (j, v) in pair.iter().enumerate() {
                    let n = v.as_f64().ok_or_else(fail)?;
                    if !n.is_finite() || !(0.0..=1.0).contains(&n) {
                        return Err(fail());
                    }
                    quad[i][j] = n;
                }
            }
            for i in 0..4 {
                let a = quad[i];
                let b = quad[(i + 1) % 4];
                let c = quad[(i + 2) % 4];
                if (b[0] - a[0]).hypot(b[1] - a[1]) < 0.005
                    || (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0.00001
                {
                    return Err(fail());
                }
            }
        }
    }
    Ok(())
}
pub fn require_legacy_live_layout(project: &Value) -> Result<(), String> {
    let Some(layout) = project.get("layout") else {
        return Ok(());
    };
    let error = || {
        "Live Manga v1は従来の4コマ配置だけに対応しています。自由コマ割りはPNG/CBZで書き出してください".to_string()
    };
    let panels = project["panels"].as_array().ok_or_else(error)?;
    let ids = panels.iter().filter_map(|p| p["id"].as_str()).collect();
    validate(layout, Some(&ids))?;
    if layout
        .get("imageCrops")
        .and_then(Value::as_object)
        .is_some_and(|v| !v.is_empty())
    {
        return Err("Live Manga v1は画像トリミング未対応です。PNG/CBZで書き出してください".into());
    }
    let pages = layout["pages"].as_array().ok_or_else(error)?;
    if pages.len() != panels.len().div_ceil(4) {
        return Err(error());
    }
    for (page_index, page) in pages.iter().enumerate() {
        let slots = page["slots"].as_array().ok_or_else(error)?;
        if slots.len() != (panels.len() - page_index * 4).min(4) {
            return Err(error());
        }
        for (i, slot) in slots.iter().enumerate() {
            if slot["panelId"] != panels[page_index * 4 + i]["id"] {
                return Err(error());
            }
            let x = if i % 2 == 0 { 820.0 } else { 60.0 };
            let y = 60.0 + (i / 2) as f64 * 1080.0;
            let expected = [
                [x / 1600.0, y / 2260.0],
                [(x + 720.0) / 1600.0, y / 2260.0],
                [(x + 720.0) / 1600.0, (y + 1030.0) / 2260.0],
                [x / 1600.0, (y + 1030.0) / 2260.0],
            ];
            for (j, point) in expected.iter().enumerate() {
                for (k, n) in point.iter().enumerate() {
                    if slot["points"][j][k]
                        .as_f64()
                        .is_none_or(|v| (v - n).abs() > 1e-10)
                    {
                        return Err(error());
                    }
                }
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
    fn crop_validation_and_live_guard() {
        let mut l = json!({"version":1,"pages":[],"imageCrops":{"p":{"zoom":2,"x":0.5,"y":0.5}}});
        assert!(validate(&l, None).is_ok());
        assert!(require_legacy_live_layout(&json!({"layout":l,"panels":[]})).is_err());
        for bad in [
            Value::Null,
            json!({}),
            json!({"zoom":9,"x":0.5,"y":0.5}),
            json!({"zoom":1,"x":-0.1,"y":0.5}),
        ] {
            l["imageCrops"]["p"] = bad;
            assert!(validate(&l, None).is_err());
        }
    }
    #[test]
    fn legacy_live_export_rejects_shape_and_assignment_changes() {
        let x = 820.0;
        let y = 60.0;
        let mut p = json!({"panels":[{"id":"p"}],"layout":{"version":1,"pages":[{"id":"page","slots":[{"id":"slot","panelId":"p","points":[[x/1600.0,y/2260.0],[(x+720.0)/1600.0,y/2260.0],[(x+720.0)/1600.0,(y+1030.0)/2260.0],[x/1600.0,(y+1030.0)/2260.0]]}]}]}});
        assert!(require_legacy_live_layout(&p).is_ok());
        p["layout"]["pages"][0]["slots"][0]["points"][0][0] = json!(0.6);
        assert!(require_legacy_live_layout(&p).is_err());
        p["layout"]["pages"][0]["slots"][0]["panelId"] = Value::Null;
        assert!(require_legacy_live_layout(&p).is_err());
    }
    #[test]
    fn rejects_crossings_missing_references_and_invalid_coordinates() {
        let mut l = json!({"version":1,"pages":[{"id":"a","slots":[{"id":"s","panelId":"p","points":[[0.1,0.1],[0.9,0.1],[0.8,0.9],[0.2,0.9]]}]}]});
        let ids = HashSet::from(["p"]);
        assert!(validate(&l, Some(&ids)).is_ok());
        assert!(validate(&l, Some(&HashSet::new())).is_err());
        l["pages"][0]["slots"][0]["points"][2] = json!([0.0, 0.0]);
        assert!(validate(&l, Some(&ids)).is_err());
        l["pages"][0]["slots"][0]["points"][2] = json!([1.2, 0.9]);
        assert!(validate(&l, Some(&ids)).is_err());
    }
}
