//! Page geometry validation shared by persistence and the existing LLM router.
use serde_json::Value;
use std::collections::HashSet;
pub fn validate(layout: &Value, panel_ids: Option<&HashSet<&str>>) -> Result<(), String> {
    let fail = || "Invalid page layout".to_string();
    if layout["version"].as_u64() != Some(1) {
        return Err(fail());
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
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
