//! Prepared source edits share the project transaction and existing Job/history stores.
use super::{err, raw_project, save_in_transaction, source_refs, Result};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};
fn array<'a>(v: &'a Value, name: &str) -> Result<&'a Vec<Value>> {
    v.as_array().ok_or_else(|| format!("Invalid {name}"))
}
fn overlaps(a: &Value, b: &Value) -> bool {
    a["snapshotId"] == b["snapshotId"]
        && a["sceneId"] == b["sceneId"]
        && a["startCp"].as_u64() < b["endCp"].as_u64()
        && b["startCp"].as_u64() < a["endCp"].as_u64()
}
fn identity(p: &Value, work: &str, base: &str, target: &str) -> Result<()> {
    if p["version"] != 5 || p["workId"].as_str() != Some(work) {
        return Err("Different source work".into());
    }
    if source_refs::token(p) != base || p["active"].as_str() != Some(target) {
        return Err("Stale source patch; reload the changes".into());
    }
    Ok(())
}
// Rebuild B' independently from bounded operations against the same old B.
fn expected_units(p: &Value, expected: &Value) -> Result<Value> {
    let old = array(&p["sourceApplication"]["units"], "old units")?;
    let after = array(&expected["afterUnits"], "expected units")?;
    let edits = array(&expected["sourceEdits"], "source edits")?;
    let mut removed = HashSet::new();
    let mut additions: Vec<(usize, u64, Vec<Value>)> = vec![];
    for edit in edits {
        let start = edit["start"].as_u64().ok_or("Missing edit start")? as usize;
        let end = edit["end"].as_u64().ok_or("Missing edit end")? as usize;
        if start > end || end > old.len() {
            return Err("Invalid edit interval".into());
        }
        if edit["beforeUnitId"]
            != if start > 0 {
                old[start - 1]["id"].clone()
            } else {
                Value::Null
            }
            || edit["afterUnitId"]
                != if end < old.len() {
                    old[end]["id"].clone()
                } else {
                    Value::Null
                }
        {
            return Err("Source anchors changed".into());
        }
        let ids = array(&edit["oldUnitIds"], "old IDs")?;
        let refs = array(&edit["newRefs"], "new refs")?;
        let kind = edit["kind"].as_str().ok_or("Missing edit kind")?;
        let (from, to) = if kind == "move" {
            (
                edit["moveStart"].as_u64().ok_or("Missing move start")? as usize,
                edit["moveEnd"].as_u64().ok_or("Missing move end")? as usize,
            )
        } else {
            (start, end)
        };
        if from > to || to > old.len() || old[from..to].iter().map(|u| &u["id"]).ne(ids.iter()) {
            return Err("Source edit does not match B".into());
        }
        for id in ids {
            if !removed.insert(id.as_str().ok_or("Invalid unit ID")?.to_string()) {
                return Err("Overlapping source edits".into());
            }
        }
        for r in refs {
            if r["snapshotId"] != p["active"] {
                return Err("New source must refer to the target snapshot".into());
            }
            source_refs::resolve(p, r)?;
        }
        let entries = match kind {
            "move" => {
                if start != end || ids.is_empty() || refs.len() != ids.len() {
                    return Err("Invalid move".into());
                }
                for (unit, r) in old[from..to].iter().zip(refs) {
                    if unit["source"]["sceneId"] != r["sceneId"]
                        || source_refs::resolve(p, &unit["source"])? != source_refs::resolve(p, r)?
                    {
                        return Err("Move changes source text".into());
                    }
                }
                old[from..to].to_vec()
            }
            "insert" | "replace" | "delete" => {
                if (kind == "insert" && (start != end || refs.is_empty()))
                    || (kind == "delete" && (start == end || !refs.is_empty()))
                    || (kind == "replace" && (start == end || refs.is_empty()))
                {
                    return Err("Invalid source edit kind".into());
                }
                let mut result = vec![];
                for r in refs {
                    let matches: Vec<_> = after.iter().filter(|u| u["source"] == *r).collect();
                    if matches.len() != 1 {
                        return Err("Ambiguous new unit".into());
                    }
                    let unit = matches[0];
                    if old.iter().any(|o| o["id"] == unit["id"])
                        || unit["requiredText"] != json!([r])
                    {
                        return Err("New content requires new identity and full text policy".into());
                    }
                    result.push(unit.clone());
                }
                result
            }
            _ => return Err("Unknown source edit".into()),
        };
        additions.push((
            start,
            edit["targetStart"].as_u64().ok_or("Missing target order")?,
            entries,
        ));
    }
    additions.sort_by_key(|(start, order, _)| (*start, *order));
    let mut rebuilt = vec![];
    for index in 0..=old.len() {
        for (_, _, units) in additions.iter().filter(|(at, _, _)| *at == index) {
            rebuilt.extend(units.clone());
        }
        if index < old.len()
            && !removed.contains(old[index]["id"].as_str().ok_or("Invalid old ID")?)
        {
            rebuilt.push(old[index].clone());
        }
    }
    if rebuilt != *after {
        return Err("Expected application includes unselected edits".into());
    }
    Ok(json!({"version":1,"units":rebuilt}))
}
fn scope(p: &Value, expected: &Value) -> Result<Value> {
    let units = array(&p["sourceApplication"]["units"], "units")?;
    let edits = array(&expected["sourceEdits"], "edits")?;
    let changed: Vec<_> = units
        .iter()
        .filter(|u| {
            edits.iter().any(|e| {
                e["oldUnitIds"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&u["id"]))
            })
        })
        .collect();
    let anchors: Vec<_> = units
        .iter()
        .filter(|u| {
            edits
                .iter()
                .any(|e| e["beforeUnitId"] == u["id"] || e["afterUnitId"] == u["id"])
        })
        .collect();
    let panels = array(&p["panels"], "panels")?;
    let ids: Vec<_> = panels
        .iter()
        .filter(|panel| {
            panel["sourceRefs"].as_array().is_some_and(|refs| {
                refs.iter()
                    .any(|r| changed.iter().any(|u| overlaps(r, &u["source"])))
            })
        })
        .map(|panel| panel["id"].clone())
        .collect();
    let neighbors: Vec<_> = panels
        .iter()
        .filter(|panel| {
            panel["sourceRefs"].as_array().is_some_and(|refs| {
                refs.iter()
                    .any(|r| anchors.iter().any(|u| overlaps(r, &u["source"])))
            })
        })
        .map(|panel| panel["id"].clone())
        .collect();
    let pages: Vec<_> = array(&p["layout"]["pages"], "pages")?
        .iter()
        .filter(|page| {
            page["slots"].as_array().is_some_and(|slots| {
                slots
                    .iter()
                    .any(|s| ids.contains(&s["panelId"]) || neighbors.contains(&s["panelId"]))
            })
        })
        .map(|page| page["id"].clone())
        .collect();
    Ok(json!({"panelIds":ids,"pageIds":pages}))
}
// The read set is minted from native state, never accepted from the model/UI.
fn dependencies(p: &Value, scope: &Value, expected: &Value) -> Result<Value> {
    let edits = array(&expected["sourceEdits"], "edits")?;
    let units: Vec<_> = array(&p["sourceApplication"]["units"], "units")?
        .iter()
        .filter(|u| {
            edits.iter().any(|e| {
                e["beforeUnitId"] == u["id"]
                    || e["afterUnitId"] == u["id"]
                    || e["oldUnitIds"]
                        .as_array()
                        .is_some_and(|ids| ids.contains(&u["id"]))
            })
        })
        .cloned()
        .collect();
    let page_ids = array(&scope["pageIds"], "pages")?;
    let pages = array(&p["layout"]["pages"], "pages")?;
    let selected: Vec<_> = pages
        .iter()
        .filter(|page| page_ids.contains(&page["id"]))
        .cloned()
        .collect();
    let mut intervals = vec![];
    for (i, page) in pages.iter().enumerate() {
        if page_ids.contains(&page["id"]) && (i == 0 || !page_ids.contains(&pages[i - 1]["id"])) {
            let mut end = i + 1;
            while end < pages.len() && page_ids.contains(&pages[end]["id"]) {
                end += 1;
            }
            intervals.push(json!({"before":if i>0 {pages[i-1]["id"].clone()} else {Value::Null}, "pages":pages[i..end].iter().map(|p|p["id"].clone()).collect::<Vec<_>>(), "after":pages.get(end).map(|p|p["id"].clone()).unwrap_or(Value::Null)}));
        }
    }
    let panel_ids: Vec<_> = selected
        .iter()
        .flat_map(|page| {
            page["slots"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| s["panelId"].clone())
        })
        .collect();
    let primary: Vec<_> = array(&p["panels"], "panels")?
        .iter()
        .filter(|panel| panel_ids.contains(&panel["id"]))
        .collect();
    let context: Vec<_> = primary
        .iter()
        .flat_map(|panel| panel["contextRefs"].as_array().into_iter().flatten())
        .collect();
    let panels: Vec<_> = array(&p["panels"], "panels")?
        .iter()
        .filter(|panel| {
            panel_ids.contains(&panel["id"])
                || panel["sourceRefs"]
                    .as_array()
                    .is_some_and(|refs| refs.iter().any(|r| context.iter().any(|c| overlaps(r, c))))
        })
        .cloned()
        .collect();
    let crops: Vec<_> = panels
        .iter()
        .map(|panel| {
            json!([
                panel["id"],
                p["layout"]["imageCrops"][panel["id"].as_str().unwrap_or("")]
            ])
        })
        .collect();
    let mut layout = p["layout"].clone();
    if let Some(value) = layout.as_object_mut() {
        value.remove("pages");
        value.remove("imageCrops");
    }
    Ok(json!(super::hash(json!({"layout":layout,"active":p["active"],"snapshot":p["snapshots"].as_array().and_then(|s|s.iter().find(|s|s["id"]==p["active"])),"characters":p["characters"],"style":p["style_references"],"units":units,"panels":panels,"pages":selected,"intervals":intervals,"crops":crops,"motions":p["panelMotions"]}).to_string().as_bytes())))
}
fn same_edits(a: &Value, b: &Value) -> Result<bool> {
    let a = array(&a["sourceEdits"], "edits")?;
    let b = array(&b["sourceEdits"], "edits")?;
    Ok(a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            [
                "kind",
                "oldUnitIds",
                "newRefs",
                "beforeUnitId",
                "afterUnitId",
                "targetStart",
            ]
            .iter()
            .all(|key| a[*key] == b[*key])
        }))
}
pub fn validate_dependencies(p: &Value, plan: &Value) -> Result<()> {
    if plan.get("dependencies").is_some()
        && plan["dependencies"] != dependencies(p, &plan["scope"], &plan["expected"])?
    {
        return Err("Source dependencies changed; candidate retained for review".into());
    }
    Ok(())
}
pub fn rebase(
    db: &mut Connection,
    root: &Path,
    work: &str,
    op: &str,
    base: &str,
    expected: Value,
) -> Result<Value> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let mut p = raw_project(&tx)?;
    let target = p["active"].as_str().ok_or("Missing target")?.to_owned();
    identity(&p, work, base, &target)?;
    let job = array(&p["jobs"], "jobs")?
        .iter()
        .find(|j| j["id"] == op)
        .ok_or("Missing source job")?;
    if job["status"] == "cancelled" || job["status"] == "complete" {
        return Err("Source job no longer active".into());
    }
    let previous = &job["source_patch"];
    if previous["targetSnapshotId"] != target || !same_edits(&previous["expected"], &expected)? {
        return Err("Source selection changed; replan required".into());
    }
    let scope = scope(&p, &expected)?;
    let current_dependencies = dependencies(&p, &scope, &previous["expected"])?;
    let valid_dependencies = if previous.get("dependencies").is_some() {
        previous["dependencies"] == current_dependencies
    } else {
        previous["baseContentToken"] == base
    };
    if scope != previous["scope"] || !valid_dependencies {
        return Err("Source dependencies changed; candidate retained for review".into());
    }
    let application = expected_units(&p, &expected)?;
    let mut plan = previous.clone();
    plan["dependencies"] = current_dependencies;
    plan["baseContentToken"] = json!(base);
    plan["expected"] = expected;
    plan["sourceApplication"] = application;
    p["jobs"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|j| j["id"] == op)
        .unwrap()["source_patch"] = plan.clone();
    save_in_transaction(&tx, root, &p.to_string(), true)?;
    tx.commit().map_err(err)?;
    Ok(plan)
}
pub fn prepare(
    db: &mut Connection,
    root: &Path,
    work: &str,
    op: &str,
    base: &str,
    target: &str,
    expected: Value,
) -> Result<Value> {
    if !super::backup::uuid(op) {
        return Err("Invalid operation ID".into());
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let mut p = raw_project(&tx)?;
    identity(&p, work, base, target)?;
    let application = expected_units(&p, &expected)?;
    let scope = scope(&p, &expected)?;
    let dependencies = dependencies(&p, &scope, &expected)?;
    let plan = json!({"baseContentToken":base,"targetSnapshotId":target,"expected":expected,"sourceApplication":application,"scope":scope,"dependencies":dependencies});
    let jobs = p["jobs"].as_array_mut().ok_or("Missing jobs")?;
    if let Some(job) = jobs.iter().find(|j| j["id"].as_str() == Some(op)) {
        if job["source_patch"] != plan {
            return Err("Operation ID already has another plan".into());
        }
    } else {
        jobs.push(json!({"id":op,"kind":"sourcePatch","status":"planned","source_patch":plan}));
    }
    save_in_transaction(&tx, root, &p.to_string(), false)?;
    tx.commit().map_err(err)?;
    Ok(plan)
}
fn validate_patch(p: &Value, plan: &Value, patch: &Value) -> Result<Value> {
    if patch
        .as_object()
        .ok_or("Invalid patch")?
        .keys()
        .any(|key| !["panels", "layout", "sourceApplication"].contains(&key.as_str()))
    {
        return Err("Source patches may only change manga and its application".into());
    }
    if patch["sourceApplication"] != plan["sourceApplication"] {
        return Err("Patch changes the prepared source application".into());
    }
    let mut next = p.clone();
    for key in ["panels", "layout", "sourceApplication"] {
        next[key] = patch.get(key).ok_or("Incomplete source patch")?.clone();
    }
    let ids = array(&plan["scope"]["panelIds"], "scope")?;
    let new = array(&next["panels"], "panels")?;
    for panel in array(&p["panels"], "panels")? {
        let target = new.iter().find(|n| n["id"] == panel["id"]);
        if !ids.contains(&panel["id"]) && target != Some(panel) {
            return Err("Outside panel changed".into());
        }
        if let Some(target) = target {
            if target["sourceRefs"] != panel["sourceRefs"] {
                return Err("Changed content requires a new panel ID".into());
            }
        } else {
            if panel["manual"] == true {
                return Err("Cannot delete manual content".into());
            }
            let replacement_refs: Vec<_> = new
                .iter()
                .filter(|n| {
                    n["replacesPanelIds"]
                        .as_array()
                        .is_some_and(|ids| ids.contains(&panel["id"]))
                })
                .flat_map(|n| n["sourceRefs"].as_array().into_iter().flatten())
                .collect();
            for r in panel["sourceRefs"].as_array().into_iter().flatten() {
                for unit in plan["sourceApplication"]["units"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|u| overlaps(r, &u["source"]))
                {
                    let mut retained = r.clone();
                    retained["startCp"] = json!(r["startCp"]
                        .as_u64()
                        .unwrap()
                        .max(unit["source"]["startCp"].as_u64().unwrap()));
                    retained["endCp"] = json!(r["endCp"]
                        .as_u64()
                        .unwrap()
                        .min(unit["source"]["endCp"].as_u64().unwrap()));
                    if !source_refs::covers(&retained, &replacement_refs) {
                        return Err("Cannot delete retained source without reconstruction".into());
                    }
                }
            }
        }
        for b in panel["lettering"]["boxes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["locked"] == true)
        {
            if target
                .and_then(|n| n["lettering"]["boxes"].as_array())
                .and_then(|bs| bs.iter().find(|n| n["id"] == b["id"]))
                != Some(b)
            {
                return Err("Locked lettering changed".into());
            }
        }
    }
    let allowed = array(&plan["scope"]["pageIds"], "page scope")?;
    let old_pages = array(&p["layout"]["pages"], "old pages")?;
    let new_pages = array(&next["layout"]["pages"], "new pages")?;
    let outside: Vec<_> = old_pages
        .iter()
        .filter(|page| !allowed.contains(&page["id"]))
        .collect();
    let retained: Vec<_> = new_pages
        .iter()
        .filter(|page| outside.iter().any(|old| old["id"] == page["id"]))
        .collect();
    if outside != retained {
        return Err("Outside pages changed or moved".into());
    }
    for (index, page) in new_pages.iter().enumerate() {
        if outside.iter().any(|old| old["id"] == page["id"]) {
            continue;
        }
        let before = new_pages[..index]
            .iter()
            .rev()
            .find(|page| outside.iter().any(|old| old["id"] == page["id"]));
        let after = new_pages[index + 1..]
            .iter()
            .find(|page| outside.iter().any(|old| old["id"] == page["id"]));
        let start = before
            .and_then(|p| old_pages.iter().position(|old| old["id"] == p["id"]))
            .map_or(0, |i| i + 1);
        let end = after
            .and_then(|p| old_pages.iter().position(|old| old["id"] == p["id"]))
            .unwrap_or(old_pages.len());
        if start > end
            || (!old_pages.is_empty()
                && !old_pages[start..end]
                    .iter()
                    .any(|p| allowed.contains(&p["id"])))
        {
            return Err("Page insertion is outside the prepared layout intervals".into());
        }
        if let Some(old_index) = old_pages.iter().position(|old| old["id"] == page["id"]) {
            if old_index < start || old_index >= end {
                return Err("Page moved across an unselected interval".into());
            }
        }
    }
    let crop_ids: HashSet<_> = p["layout"]["imageCrops"]
        .as_object()
        .into_iter()
        .flatten()
        .chain(
            next["layout"]["imageCrops"]
                .as_object()
                .into_iter()
                .flatten(),
        )
        .map(|(id, _)| id)
        .collect();
    for id in crop_ids {
        if !ids.contains(&json!(id))
            && p["layout"]["imageCrops"][id] != next["layout"]["imageCrops"][id]
        {
            return Err("Outside crop changed".into());
        }
    }
    source_refs::validate(&next)?;
    Ok(next)
}
pub fn commit(
    db: &mut Connection,
    root: &Path,
    work: &str,
    op: &str,
    base: &str,
    target: &str,
    mut patch: Value,
) -> Result<Value> {
    let latest = raw_project(db)?;
    if latest["workId"].as_str() != Some(work) {
        return Err("Different source work".into());
    }
    if latest["sourcePatchReceipts"].get(op).is_some() {
        return loaded(db, root);
    }
    // Publish and verify immutable images before acquiring the write transaction.
    super::externalize(&mut patch, &root.join("artifacts"))?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let p = raw_project(&tx)?;
    if p["workId"].as_str() != Some(work) {
        return Err("Different source work".into());
    }
    if p["sourcePatchReceipts"].get(op).is_some() {
        return loaded(&tx, root);
    }
    identity(&p, work, base, target)?;
    let job = array(&p["jobs"], "jobs")?
        .iter()
        .find(|j| j["id"].as_str() == Some(op))
        .ok_or("Source plan must be prepared first")?;
    if job["status"] == "cancelled" {
        return Err("Source plan was cancelled".into());
    }
    let plan = &job["source_patch"];
    if plan["baseContentToken"] != base || plan["targetSnapshotId"] != target {
        return Err("Source plan identity changed".into());
    }
    expected_units(&p, &plan["expected"])?;
    validate_dependencies(&p, plan)?;
    let mut next = validate_patch(&p, plan, &patch)?;
    let before = json!({"panels":p["panels"],"layout":p["layout"],"sourceApplication":p["sourceApplication"],"layoutHistory":p.get("layoutHistory").cloned().unwrap_or(json!([])),"layoutRedo":p.get("layoutRedo").cloned().unwrap_or(json!([]))});
    next["layoutHistory"] = json!([]);
    next["layoutRedo"] = json!([]);
    let after = json!({"panels":next["panels"],"layout":next["layout"],"sourceApplication":next["sourceApplication"],"layoutHistory":[],"layoutRedo":[]});
    let mut entry = before;
    entry["sourcePatch"] = json!(true);
    entry["edit"] = json!(true);
    entry["opId"] = json!(op);
    entry["label"] = json!("原稿差分を反映");
    entry["after"] = after;
    next["history"]
        .as_array_mut()
        .ok_or("Missing history")?
        .push(entry);
    next["editRedo"] = json!([]);
    next.as_object_mut()
        .unwrap()
        .entry("sourcePatchReceipts")
        .or_insert(json!({}))[op] = json!({"baseContentToken":base,"targetSnapshotId":target});
    next["jobs"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|j| j["id"].as_str() == Some(op))
        .unwrap()["status"] = json!("complete");
    save_in_transaction(&tx, root, &next.to_string(), true)?;
    tx.commit().map_err(err)?;
    loaded(db, root)
}
fn loaded(db: &Connection, root: &Path) -> Result<Value> {
    serde_json::from_str(&super::load(db, root)?.ok_or("Missing project")?).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let image = super::super::tests::fixture()["panels"][0]["image"].clone();
        let source = json!({"snapshotId":"s","sceneId":"scene","startCp":0,"endCp":1});
        json!({"version":5,"workId":"work","active":"s","snapshots":[{"id":"s","scenes":[{"id":"scene","text":"A","sourceHash":super::super::hash(b"A")}]}],"panels":[],"layout":{"version":1,"pages":[]},"sourceApplication":{"version":1,"units":[]},"history":[],"jobs":[],"fixtureImage":image,"fixtureSource":source})
    }
    fn request(p: &Value) -> (Value, Value) {
        let source = p["fixtureSource"].clone();
        let unit = json!({"id":"new-unit","source":source,"requiredText":[source]});
        let expected = json!({"afterUnits":[unit],"sourceEdits":[{"kind":"insert","start":0,"end":0,"targetStart":0,"beforeUnitId":null,"afterUnitId":null,"oldUnitIds":[],"newRefs":[source]}]});
        let patch = json!({"sourceApplication":{"version":1,"units":[unit]},"panels":[{"id":"p","sourceRefs":[source],"contextRefs":[],"image":p["fixtureImage"],"lettering":{"mode":"caption","boxes":[{"id":"box","sourceRefs":[source],"x":0.1,"y":0.1,"width":0.5,"height":0.2}]}}],"layout":{"version":1,"pages":[{"id":"page","slots":[{"id":"slot","panelId":"p","points":[[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]}]}]}});
        (expected, patch)
    }
    #[test]
    fn commit_is_atomic_retry_safe_and_receipts_survive_undo_and_restart() {
        let (mut db, root) = super::super::tests::setup();
        let p = fixture();
        super::super::save(&mut db, &root, &p.to_string()).unwrap();
        let base = source_refs::token(&raw_project(&db).unwrap());
        let op = uuid::Uuid::new_v4().to_string();
        let (expected, patch) = request(&p);
        prepare(&mut db, &root, "work", &op, &base, "s", expected).unwrap();
        // Failure at the final SQLite write leaves manga, application and receipt untouched.
        let before = raw_project(&db).unwrap();
        db.execute_batch("CREATE TRIGGER fail_patch BEFORE UPDATE ON project BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;").unwrap();
        assert!(commit(&mut db, &root, "work", &op, &base, "s", patch.clone()).is_err());
        assert_eq!(raw_project(&db).unwrap(), before);
        db.execute_batch("DROP TRIGGER fail_patch;").unwrap();
        let adopted = commit(&mut db, &root, "work", &op, &base, "s", patch.clone()).unwrap();
        assert_eq!(
            adopted["sourceApplication"]["units"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(adopted["history"].as_array().unwrap().len(), 1);
        let repeated = commit(&mut db, &root, "work", &op, &base, "s", patch.clone()).unwrap();
        assert_eq!(adopted, repeated);
        let mut undo = adopted.clone();
        let entry = undo["history"][0].clone();
        for key in ["panels", "layout", "sourceApplication"] {
            undo[key] = entry[key].clone();
        }
        undo["history"] = json!([]);
        undo["editRedo"] = json!([entry]);
        undo.as_object_mut().unwrap().remove("sourcePatchReceipts");
        super::super::save(&mut db, &root, &undo.to_string()).unwrap();
        drop(db);
        let mut db = Connection::open(root.join("test.sqlite3")).unwrap();
        let after_retry = commit(&mut db, &root, "work", &op, &base, "s", patch.clone()).unwrap();
        assert!(after_retry["panels"].as_array().unwrap().is_empty());
        assert!(after_retry["sourcePatchReceipts"].get(&op).is_some());
        assert_eq!(after_retry["active"], "s");
        assert_eq!(after_retry["jobs"][0]["status"], "complete");
        assert!(commit(&mut db, &root, "another-work", &op, &base, "s", patch).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shared_panel_reconstruction_keeps_unselected_old_text_and_latest_jobs() {
        let (mut db, root) = super::super::tests::setup();
        let mut p = fixture();
        let a = json!({"snapshotId":"old","sceneId":"scene","startCp":0,"endCp":1});
        let b = json!({"snapshotId":"old","sceneId":"scene","startCp":3,"endCp":4});
        let x = json!({"snapshotId":"s","sceneId":"scene","startCp":0,"endCp":1});
        p["snapshots"] = json!([{"id":"old","scenes":[{"id":"scene","text":"A\n\nB","sourceHash":super::super::hash(b"A\n\nB")}]},{"id":"s","scenes":[{"id":"scene","text":"X\n\nY","sourceHash":super::super::hash(b"X\n\nY")}]}]);
        let old_b = json!({"id":"b","source":b,"requiredText":[b]});
        p["sourceApplication"] =
            json!({"version":1,"units":[{"id":"a","source":a,"requiredText":[a]},old_b]});
        let (_, mut patch) = request(&p);
        p["panels"] = patch["panels"].clone();
        p["layout"] = patch["layout"].clone();
        p["panels"][0]["sourceRefs"] = json!([a, b]);
        p["panels"][0]["lettering"]["boxes"][0]["sourceRefs"] = json!([a, b]);
        p["jobs"] = json!([{"id":"remote","manifest":{},"status":"running"}]);
        super::super::save(&mut db, &root, &p.to_string()).unwrap();
        let base = source_refs::token(&raw_project(&db).unwrap());
        let unit = json!({"id":"x","source":x,"requiredText":[x]});
        let expected = json!({"afterUnits":[unit,old_b],"sourceEdits":[{"kind":"replace","start":0,"end":1,"targetStart":0,"beforeUnitId":null,"afterUnitId":"b","oldUnitIds":["a"],"newRefs":[x]}]});
        let op = uuid::Uuid::new_v4().to_string();
        prepare(&mut db, &root, "work", &op, &base, "s", expected).unwrap();
        patch["panels"][0]["id"] = json!("replacement");
        patch["panels"][0]["sourceRefs"] = json!([x, b]);
        patch["panels"][0]["lettering"]["boxes"][0]["sourceRefs"] = json!([x, b]);
        patch["layout"]["pages"][0]["slots"][0]["panelId"] = json!("replacement");
        patch["sourceApplication"] = json!({"version":1,"units":[unit,old_b]});
        assert!(commit(&mut db, &root, "work", &op, &base, "s", patch.clone()).is_err());
        patch["panels"][0]["replacesPanelIds"] = json!(["p"]);
        super::super::update_remote_job(&mut db, "remote", |_, _| {
            Ok(json!({"task_id":"latest","reserved_credits":99}))
        })
        .unwrap();
        let adopted = commit(&mut db, &root, "work", &op, &base, "s", patch).unwrap();
        assert_eq!(adopted["sourceApplication"]["units"][1], old_b);
        assert_eq!(adopted["jobs"][0]["remote"]["reserved_credits"], 99);
        assert_eq!(
            source_refs::resolve(&adopted, &adopted["panels"][0]["sourceRefs"][1]).unwrap(),
            "B"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn incomplete_lettering_stale_base_and_unselected_policy_are_rejected() {
        let (mut db, root) = super::super::tests::setup();
        let p = fixture();
        super::super::save(&mut db, &root, &p.to_string()).unwrap();
        let base = source_refs::token(&raw_project(&db).unwrap());
        let op = uuid::Uuid::new_v4().to_string();
        let (mut expected, mut patch) = request(&p);
        expected["afterUnits"][0]["requiredText"] = json!([]);
        assert!(prepare(&mut db, &root, "work", &op, &base, "s", expected).is_err());
        let (expected, _) = request(&p);
        prepare(&mut db, &root, "work", &op, &base, "s", expected).unwrap();
        patch["panels"][0]["lettering"]["boxes"] = json!([]);
        let before = raw_project(&db).unwrap();
        assert!(commit(&mut db, &root, "work", &op, &base, "s", patch.clone()).is_err());
        assert_eq!(raw_project(&db).unwrap(), before);
        assert!(commit(&mut db, &root, "work", &op, "stale", "s", patch).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn disjoint_fixture() -> Value {
        let mut p = fixture();
        let (_, patch) = request(&p);
        let mut old_scenes = vec![];
        let mut new_scenes = vec![];
        let mut panels = vec![];
        let mut pages = vec![];
        let mut units = vec![];
        for i in 0..9 {
            let id = format!("scene{i}");
            let old = format!("old{i}");
            let new = if i == 0 || i == 8 {
                format!("new{i}")
            } else {
                old.clone()
            };
            old_scenes
                .push(json!({"id":id,"text":old,"sourceHash":super::super::hash(old.as_bytes())}));
            new_scenes
                .push(json!({"id":id,"text":new,"sourceHash":super::super::hash(new.as_bytes())}));
            let r = json!({"snapshotId":"old","sceneId":id,"startCp":0,"endCp":4});
            units.push(json!({"id":format!("u{i}"),"source":r,"requiredText":[r]}));
            let mut panel = patch["panels"][0].clone();
            panel["id"] = json!(format!("p{i}"));
            panel["sourceRefs"] = json!([r]);
            panel["lettering"]["boxes"][0]["sourceRefs"] = json!([r]);
            panel["lettering"]["boxes"][0]["id"] = json!(format!("box{i}"));
            panels.push(panel);
            let mut page = patch["layout"]["pages"][0].clone();
            page["id"] = json!(format!("page{i}"));
            page["slots"][0]["id"] = json!(format!("slot{i}"));
            page["slots"][0]["panelId"] = json!(format!("p{i}"));
            pages.push(page);
        }
        p["snapshots"] = json!([{"id":"old","scenes":old_scenes},{"id":"s","scenes":new_scenes}]);
        p["panels"] = json!(panels);
        p["layout"]["pages"] = json!(pages);
        p["sourceApplication"]["units"] = json!(units);
        p
    }
    fn replace_request(p: &Value, index: usize) -> (Value, Value) {
        let old = &p["sourceApplication"]["units"];
        let mut units = old.as_array().unwrap().clone();
        let mut source = units[index]["source"].clone();
        source["snapshotId"] = json!("s");
        units[index] = json!({"id":format!("new{index}"),"source":source,"requiredText":[source]});
        let expected = json!({"afterUnits":units,"sourceEdits":[{"kind":"replace","start":index,"end":index+1,"targetStart":index,"beforeUnitId":if index>0 {old[index-1]["id"].clone()} else {Value::Null},"afterUnitId":old.get(index+1).map(|u|u["id"].clone()).unwrap_or(Value::Null),"oldUnitIds":[old[index]["id"]],"newRefs":[source]}]});
        let mut patch = json!({"panels":p["panels"],"layout":p["layout"],"sourceApplication":{"version":1,"units":units}});
        patch["panels"][index]["id"] = json!(format!("new-panel{index}"));
        patch["panels"][index]["replacesPanelIds"] = json!([p["panels"][index]["id"]]);
        patch["panels"][index]["sourceRefs"] = json!([source]);
        patch["panels"][index]["lettering"]["boxes"][0]["sourceRefs"] = json!([source]);
        patch["layout"]["pages"][index]["slots"][0]["panelId"] = json!(format!("new-panel{index}"));
        (expected, patch)
    }
    #[test]
    fn disjoint_adoption_rebases_native_plan_without_losing_other_result_or_undo_receipt() {
        let (mut db, root) = super::super::tests::setup();
        let p = disjoint_fixture();
        super::super::save(&mut db, &root, &p.to_string()).unwrap();
        let base = source_refs::token(&raw_project(&db).unwrap());
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        let (ea, pa) = replace_request(&p, 0);
        let (eb, pb) = replace_request(&p, 8);
        prepare(&mut db, &root, "work", &a, &base, "s", ea).unwrap();
        prepare(&mut db, &root, "work", &b, &base, "s", eb).unwrap();
        let after_b = commit(&mut db, &root, "work", &b, &base, "s", pb).unwrap();
        assert!(commit(&mut db, &root, "work", &a, &base, "s", pa).is_err());
        let base_b = after_b["contentToken"].as_str().unwrap();
        let (ea, pa) = replace_request(&after_b, 0);
        rebase(&mut db, &root, "work", &a, base_b, ea).unwrap();
        let complete = commit(&mut db, &root, "work", &a, base_b, "s", pa.clone()).unwrap();
        assert_eq!(complete["panels"][0]["id"], "new-panel0");
        assert_eq!(complete["panels"][8]["id"], "new-panel8");
        for i in 1..8 {
            assert_eq!(complete["panels"][i], p["panels"][i]);
        }
        assert_eq!(complete["history"].as_array().unwrap().len(), 2);
        assert_eq!(complete["history"][1]["panels"][8], after_b["panels"][8]);
        let mut undo = complete.clone();
        for key in ["panels", "layout", "sourceApplication"] {
            undo[key] = complete["history"][1][key].clone();
        }
        super::super::save_checked(&mut db, &root, &undo.to_string()).unwrap();
        drop(db);
        let mut db = Connection::open(root.join("test.sqlite3")).unwrap();
        let repeated = commit(&mut db, &root, "work", &a, base_b, "s", pa).unwrap();
        assert_eq!(repeated["panels"][0]["id"], "p0");
        assert_eq!(repeated["panels"][8]["id"], "new-panel8");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_rebase_rejects_target_reference_and_anchor_changes_and_save_cas_is_atomic() {
        for change in ["panel", "character", "target", "anchor"] {
            let (mut db, root) = super::super::tests::setup();
            let p = disjoint_fixture();
            super::super::save(&mut db, &root, &p.to_string()).unwrap();
            let base = source_refs::token(&raw_project(&db).unwrap());
            let op = uuid::Uuid::new_v4().to_string();
            let (expected, _) = replace_request(&p, 0);
            prepare(&mut db, &root, "work", &op, &base, "s", expected.clone()).unwrap();
            let stale = loaded(&db, &root).unwrap();
            let mut changed = stale.clone();
            match change {
                "panel" => changed["panels"][0]["prompt"] = json!("manual"),
                "character" => changed["characters"] = json!([{"id":"new"}]),
                "target" => changed["active"] = json!("old"),
                _ => changed["layout"]["pages"][2]["id"] = json!("another-anchor"),
            };
            super::super::save_checked(&mut db, &root, &changed.to_string()).unwrap();
            let latest = raw_project(&db).unwrap();
            assert!(rebase(
                &mut db,
                &root,
                "work",
                &op,
                &source_refs::token(&latest),
                expected
            )
            .is_err());
            assert_eq!(raw_project(&db).unwrap(), latest);
            if change != "character" {
                assert!(super::super::save_checked(&mut db, &root, &stale.to_string()).is_err());
                assert_eq!(raw_project(&db).unwrap(), latest);
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
