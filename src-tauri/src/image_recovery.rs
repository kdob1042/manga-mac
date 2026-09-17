//! Durable local helper handoff; uses the existing project jobs and artifact store.
use super::*;
const MAX_IMAGE: u64 = 24 * 1024 * 1024;

fn directory(root: &Path, id: &str) -> Result<PathBuf> {
    let parent = root.join("image-results");
    fs::create_dir_all(&parent).map_err(err)?;
    if !fs::symlink_metadata(&parent)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("Invalid image results directory".into());
    }
    Ok(parent.join(hash(id.as_bytes())))
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "保存済み画像がありません。生成を再送せず状態を確認してください")?;
    if !meta.file_type().is_file() || meta.len() > limit {
        return Err("Invalid image result file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(err)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() as u64 > limit {
        return Err("Image result too large".into());
    }
    Ok(bytes)
}

pub fn reserve(db: &mut Connection, root: &Path, request: &Value) -> Result<Value> {
    let id = request["job"]["id"]
        .as_str()
        .ok_or("保存済み制作要求が必要です")?;
    let tx = db.transaction().map_err(err)?;
    let mut project = raw_project(&tx)?;
    let index = project["jobs"]
        .as_array()
        .ok_or("Missing jobs")?
        .iter()
        .position(|j| j["id"] == id)
        .ok_or("Job must be saved before generation")?;
    let job = &project["jobs"][index];
    if job["status"] != "running"
        || job.get("local_image").is_some()
        || job["scope"]["type"] != "panel"
    {
        return Err(
            "制作要求は送信済みまたは無効です。再生成せず保存結果を確認してください".into(),
        );
    }
    for key in [
        "id",
        "input_hash",
        "base_revision",
        "source_revision",
        "scope",
    ] {
        if job[key] != request["job"][key] {
            return Err("Image job inputs changed".into());
        }
    }
    let context = &request["recovery"];
    if context["version"] != 1
        || context["kind"] != job["kind"]
        || context["panel"]["id"] != job["panelId"]
        || context["panel"]["snapshotId"] != job["source_revision"]
        || !context["panel"]["image"].is_null()
        || !matches!(job["kind"].as_str(), Some("generate" | "retake" | "edit"))
    {
        return Err("Invalid image recovery context".into());
    }
    for key in ["width", "height", "seed"] {
        if context["panel"]["generation"][key] != request[key] {
            return Err("Image output contract changed".into());
        }
    }
    let mut hydrated = project.clone();
    hydrate(&mut hydrated, &root.join("artifacts"))?;
    let panel = if let Some(op) = job.get("sourcePatchOp") {
        let owner = hydrated["jobs"]
            .as_array()
            .ok_or("Missing jobs")?
            .iter()
            .find(|j| j["id"] == *op)
            .ok_or("Missing source candidate")?;
        let prepared = &owner["source_candidate"]["prepared"];
        super::source_patch::validate_dependencies(&project, &owner["source_patch"])?;
        if owner["kind"] != "sourcePatch"
            || owner["status"] != "candidate"
            || owner["source_patch"]["baseContentToken"] != super::source_refs::token(&project)
            || prepared["identity"]["workId"] != project["workId"]
            || prepared["identity"]["targetSnapshotId"] != project["active"]
            || prepared["expected"] != owner["source_patch"]["expected"]
            || job["kind"] != "generate"
        {
            return Err("Source generation candidate is stale or inactive".into());
        }
        owner["source_candidate"]["patch"]["panels"]
            .as_array()
            .ok_or("Missing candidate panels")?
            .iter()
            .find(|p| p["id"] == job["panelId"])
            .ok_or("Missing candidate panel")?
    } else {
        hydrated["panels"]
            .as_array()
            .ok_or("Missing panels")?
            .iter()
            .find(|p| p["id"] == job["panelId"])
            .ok_or("Missing panel")?
    };
    if panel["artwork_revision"] != job["base_revision"]
        || panel["snapshotId"] != job["source_revision"]
    {
        return Err("Image base revision changed".into());
    }
    if job["kind"] == "edit" {
        let rect = context["rect"].as_array().ok_or("Missing edit region")?;
        let coords: Option<Vec<f64>> = rect.iter().map(Value::as_f64).collect();
        let r = coords.ok_or("Invalid edit region")?;
        if r.len() != 4
            || r.iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 1.0)
            || r[2] <= 0.0
            || r[3] <= 0.0
            || r[0] + r[2] > 1.0
            || r[1] + r[3] > 1.0
            || context["original"] != panel["image"]
        {
            return Err("Invalid edit source or region".into());
        }
        let uri = context["original"].as_str().ok_or("Missing edit source")?;
        let bytes = STANDARD
            .decode(uri.split_once(',').ok_or("Invalid edit source")?.1)
            .map_err(err)?;
        if context["original_hash"] != hash(&bytes) {
            return Err("Edit source hash mismatch".into());
        }
    }
    if let Some(finishing) = job.get("finishing") {
        let placement: Value =
            serde_json::from_str(job["placement_key"].as_str().ok_or("Missing placement")?)
                .map_err(err)?;
        let slots: Vec<Value> = hydrated["layout"]["pages"]
            .as_array()
            .ok_or("Missing pages")?
            .iter()
            .flat_map(|p| p["slots"].as_array().into_iter().flatten())
            .filter(|s| s["panelId"] == panel["id"])
            .cloned()
            .collect();
        let panel_id = panel["id"].as_str().ok_or("Missing panel ID")?;
        let current = json!({"active":hydrated["active"],"slots":slots,"crop":hydrated["layout"]["imageCrops"][panel_id]});
        let uri = panel["image"].as_str().ok_or("Missing source image")?;
        let bytes = STANDARD
            .decode(uri.split_once(',').ok_or("Invalid source image")?.1)
            .map_err(err)?;
        if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
            return Err("Finishing requires PNG artwork".into());
        }
        let w = u32::from_be_bytes(bytes[16..20].try_into().map_err(err)?) as u64;
        let h = u32::from_be_bytes(bytes[20..24].try_into().map_err(err)?) as u64;
        let out_w = request["width"].as_u64().unwrap_or(0);
        let out_h = request["height"].as_u64().unwrap_or(0);
        if job["kind"] != "retake"
            || finishing["method"] != "reference-regeneration"
            || finishing != &context["panel"]["finishing"]
            || placement != current
            || slots.len() != 1
            || finishing["parent_hash"] != hash(&bytes)
            || finishing["parent_revision"] != panel["artwork_revision"]
            || finishing["sourceWidth"] != w
            || finishing["sourceHeight"] != h
            || finishing["width"] != out_w
            || finishing["height"] != out_h
            || w == 0
            || h == 0
            || w > 4096
            || h > 4096
            || !(256..=1024).contains(&out_w)
            || !(256..=1024).contains(&out_h)
            || !out_w.is_multiple_of(64)
            || !out_h.is_multiple_of(64)
            || out_w * h != out_h * w
            || request["original"].as_str().is_none()
        {
            return Err("Finishing source, placement or dimensions changed".into());
        }
    }
    let request_hash = hash(request.to_string().as_bytes());
    let mut metadata = json!({"context":context,"request_hash":request_hash});
    externalize(&mut metadata, &root.join("artifacts"))?;
    project["jobs"][index]["local_image"] = metadata;
    tx.execute(
        "UPDATE project SET data=?1 WHERE id=1",
        [project.to_string()],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    // Reserve once even if launch/directory creation fails. Never repeat inference.
    let dir = directory(root, id)?;
    fs::create_dir(&dir).map_err(err)?;
    sync_dir(dir.parent().ok_or("Missing parent")?)?;
    Ok(json!({"directory":dir.to_str().ok_or("Invalid output path")?,"request_hash":request_hash}))
}

pub fn recover(db: &Connection, root: &Path, id: &str) -> Result<Value> {
    let project = raw_project(db)?;
    let job = project["jobs"]
        .as_array()
        .ok_or("Missing jobs")?
        .iter()
        .find(|j| j["id"] == id)
        .ok_or("Missing image job")?;
    if !matches!(job["status"].as_str(), Some("running" | "unknown"))
        || job["local_image"]["request_hash"].as_str().is_none()
    {
        return Err("この要求には回収可能な画像情報がありません".into());
    }
    let dir = directory(root, id)?;
    if !fs::symlink_metadata(&dir)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("Invalid image job directory".into());
    }
    let receipt: Value = serde_json::from_slice(&read_bounded(&dir.join("receipt.json"), 4096)?)
        .map_err(|_| "Invalid image receipt")?;
    if receipt["request_hash"] != job["local_image"]["request_hash"] {
        return Err("Image request receipt mismatch".into());
    }
    let bytes = read_bounded(&dir.join("result.png"), MAX_IMAGE)?;
    let digest = hash(&bytes);
    if receipt["hash"] != digest
        || bytes.len() < 24
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
    {
        return Err("Image result hash or format mismatch".into());
    }
    let mut context = job["local_image"]["context"].clone();
    hydrate(&mut context, &root.join("artifacts"))?;
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(err)?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(err)?);
    if context["panel"]["generation"]["width"] != width
        || context["panel"]["generation"]["height"] != height
    {
        return Err("Image output dimensions mismatch".into());
    }
    // Canonical artifacts are the existing hash store; collecting twice is harmless.
    put(&root.join("artifacts"), &bytes)?;
    Ok(
        json!({"job_id":id,"input_hash":job["input_hash"],"context":context,"hash":digest,"image":format!("data:image/png;base64,{}",STANDARD.encode(bytes))}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (Connection, PathBuf, Value, Value) {
        let (mut db, root) = super::super::tests::setup();
        let mut project = super::super::tests::fixture();
        let mut panel = project["panels"][0].clone();
        panel["artwork_revision"] = Value::Null;
        project["panels"][0] = panel.clone();
        let job = json!({"id":"local-1","kind":"edit","panelId":panel["id"],"scope":{"type":"panel","id":panel["id"]},"source_revision":panel["snapshotId"],"base_revision":null,"input_hash":"fixture-input","status":"running"});
        project["jobs"] = json!([job.clone()]);
        save(&mut db, &root, &project.to_string()).unwrap();
        let image = panel["image"].clone();
        let bytes = STANDARD
            .decode(image.as_str().unwrap().split_once(',').unwrap().1)
            .unwrap();
        panel["image"] = Value::Null;
        panel["generation"] = json!({"width":1,"height":1,"seed":7});
        let request = json!({"job":job,"width":1,"height":1,"seed":7,"recovery":{"version":1,"kind":"edit","panel":panel,"original":image,"original_hash":hash(&bytes),"rect":[0.0,0.0,0.5,0.5]}});
        (db, root, project, request)
    }
    fn publish(root: &Path, destination: &Value, request: &Value) {
        let bytes = STANDARD
            .decode(
                request["recovery"]["original"]
                    .as_str()
                    .unwrap()
                    .split_once(',')
                    .unwrap()
                    .1,
            )
            .unwrap();
        let dir = directory(root, "local-1").unwrap();
        fs::write(dir.join("result.png"), &bytes).unwrap();
        fs::write(
            dir.join("receipt.json"),
            json!({"request_hash":destination["request_hash"],"hash":hash(&bytes)}).to_string(),
        )
        .unwrap();
    }
    #[test]
    fn source_candidate_generation_checks_base_without_adopting_panels() {
        for stale in [false, true] {
            let (mut db, root, mut p, mut request) = setup();
            let adopted = p["panels"].clone();
            let mut candidate = request["recovery"]["panel"].clone();
            candidate["id"] = json!("candidate-panel");
            candidate.as_object_mut().unwrap().remove("generation");
            p["workId"] = json!("work");
            p["jobs"][0]["kind"] = json!("generate");
            p["jobs"][0]["panelId"] = json!("candidate-panel");
            p["jobs"][0]["scope"]["id"] = json!("candidate-panel");
            p["jobs"][0]["sourcePatchOp"] = json!("source-op");
            save(&mut db, &root, &p.to_string()).unwrap();
            let base = super::super::source_refs::token(&raw_project(&db).unwrap());
            let active = p["active"].clone();
            p["jobs"].as_array_mut().unwrap().push(json!({
                "id":"source-op","kind":"sourcePatch","status":"candidate",
                "source_patch":{"baseContentToken":base,"expected":{}},
                "source_candidate":{"prepared":{"identity":{"workId":"work","targetSnapshotId":active},"expected":{}},"patch":{"panels":[candidate]}}
            }));
            if stale {
                p["panels"][0]["prompt"] = json!("changed after planning");
            }
            save(&mut db, &root, &p.to_string()).unwrap();
            request["job"] = p["jobs"][0].clone();
            request["recovery"]["kind"] = json!("generate");
            request["recovery"]["panel"]["id"] = json!("candidate-panel");
            assert_eq!(reserve(&mut db, &root, &request).is_ok(), !stale);
            if !stale {
                let mut result = raw_project(&db).unwrap();
                hydrate(&mut result, &root.join("artifacts")).unwrap();
                assert_eq!(result["panels"], adopted);
                assert!(reserve(&mut db, &root, &request).is_err());
            }
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn helper_completion_survives_restart_without_ui_save_and_collects_idempotently() {
        let (mut db, root, mut project, request) = setup();
        let destination = reserve(&mut db, &root, &request).unwrap();
        assert!(recover(&db, &root, "local-1").is_err());
        assert!(reserve(&mut db, &root, &request).is_err());
        publish(&root, &destination, &request);
        drop(db); // helper result exists, Rust/UI never received it
        let mut db = Connection::open(root.join("test.sqlite3")).unwrap();
        let recovered = recover(&db, &root, "local-1").unwrap();
        assert_eq!(recovered, recover(&db, &root, "local-1").unwrap());
        assert_eq!(
            recovered["context"]["original"],
            request["recovery"]["original"]
        );
        assert_eq!(recovered["context"]["rect"], request["recovery"]["rect"]);
        project["jobs"][0]["status"] = json!("unknown");
        save(&mut db, &root, &project.to_string()).unwrap(); // stale UI cannot erase native context
        assert_eq!(recovered, recover(&db, &root, "local-1").unwrap());
        let loaded: Value = serde_json::from_str(&load(&db, &root).unwrap().unwrap()).unwrap();
        assert_eq!(loaded["panels"], project["panels"]);
        assert_eq!(loaded["history"], project["history"]);
        project["jobs"][0]["input_hash"] = json!("changed");
        assert!(save(&mut db, &root, &project.to_string()).is_err());
        project["jobs"] = json!([]);
        assert!(save(&mut db, &root, &project.to_string()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_tampered_wrong_job_and_wrong_dimensions_do_not_change_adoption() {
        let (mut db, root, _, request) = setup();
        let destination = reserve(&mut db, &root, &request).unwrap();
        let before = raw_project(&db).unwrap();
        publish(&root, &destination, &request);
        let dir = directory(&root, "local-1").unwrap();
        fs::write(dir.join("receipt.json"), "{}").unwrap();
        assert!(recover(&db, &root, "local-1").is_err());
        publish(&root, &destination, &request);
        let mut bytes = fs::read(dir.join("result.png")).unwrap();
        bytes[19] = 2;
        fs::write(dir.join("result.png"), &bytes).unwrap();
        assert!(recover(&db, &root, "local-1").is_err());
        fs::write(
            dir.join("receipt.json"),
            json!({"request_hash":destination["request_hash"],"hash":hash(&bytes)}).to_string(),
        )
        .unwrap();
        assert!(recover(&db, &root, "local-1").is_err());
        assert!(recover(&db, &root, "other-job").is_err());
        assert_eq!(before, raw_project(&db).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_edit_context_and_legacy_job_cannot_launch_or_recover() {
        let (mut db, root, _, mut request) = setup();
        assert!(recover(&db, &root, "local-1").is_err());
        let before = raw_project(&db).unwrap();
        request["recovery"]["rect"] = json!([0.9, 0.0, 0.5, 0.5]);
        assert!(reserve(&mut db, &root, &request).is_err());
        request["recovery"]["rect"] = json!([0.0, 0.0, 0.5, 0.5]);
        request["recovery"]["original_hash"] = json!("wrong");
        assert!(reserve(&mut db, &root, &request).is_err());
        assert_eq!(before, raw_project(&db).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn linked_result_and_oversized_receipt_are_rejected() {
        let (mut db, root, _, request) = setup();
        let destination = reserve(&mut db, &root, &request).unwrap();
        publish(&root, &destination, &request);
        let dir = directory(&root, "local-1").unwrap();
        fs::rename(dir.join("result.png"), root.join("external.png")).unwrap();
        std::os::unix::fs::symlink(root.join("external.png"), dir.join("result.png")).unwrap();
        assert!(recover(&db, &root, "local-1").is_err());
        fs::write(dir.join("receipt.json"), vec![b' '; 4097]).unwrap();
        assert!(recover(&db, &root, "local-1").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finishing_reservation_checks_source_placement_and_protects_metadata() {
        let (mut db, root, mut project, mut request) = setup();
        let panel_id = project["panels"][0]["id"].clone();
        let slot = json!({"id":"slot","panelId":panel_id,"points":[[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]});
        project["layout"] = json!({"version":1,"knownPanelIds":[panel_id],"pages":[{"id":"page","slots":[slot.clone()]}]});
        let placement = json!({"active":project["active"],"slots":[slot],"crop":null});
        let bytes = STANDARD
            .decode(
                project["panels"][0]["image"]
                    .as_str()
                    .unwrap()
                    .split_once(',')
                    .unwrap()
                    .1,
            )
            .unwrap();
        let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        let finishing = json!({"method":"reference-regeneration","sourceWidth":w,"sourceHeight":h,"width":256,"height":256,"parent_hash":hash(&bytes),"parent_revision":null});
        project["jobs"][0]["kind"] = json!("retake");
        project["jobs"][0]["placement_key"] = json!(placement.to_string());
        project["jobs"][0]["finishing"] = finishing.clone();
        save(&mut db, &root, &project.to_string()).unwrap();
        request["job"] = project["jobs"][0].clone();
        request["width"] = json!(256);
        request["height"] = json!(256);
        request["original"] = project["panels"][0]["image"].clone();
        request["recovery"]["kind"] = json!("retake");
        request["recovery"]["panel"]["generation"]["width"] = json!(256);
        request["recovery"]["panel"]["generation"]["height"] = json!(256);
        request["recovery"]["panel"]["finishing"] = finishing;
        let mut bad = request.clone();
        bad["recovery"]["panel"]["finishing"]["parent_hash"] = json!("wrong");
        assert!(reserve(&mut db, &root, &bad).is_err());
        let mut moved = project.clone();
        moved["layout"]["imageCrops"] =
            json!({panel_id.as_str().unwrap():{"zoom":2,"x":0.5,"y":0.5}});
        save(&mut db, &root, &moved.to_string()).unwrap();
        assert!(reserve(&mut db, &root, &request).is_err());
        save(&mut db, &root, &project.to_string()).unwrap();
        reserve(&mut db, &root, &request).unwrap();
        assert!(reserve(&mut db, &root, &request).is_err());
        project["jobs"][0]["finishing"]["width"] = json!(512);
        assert!(save(&mut db, &root, &project.to_string()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
