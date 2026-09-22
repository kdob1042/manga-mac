use manga_llm_contracts::blender_live::{command, Live};
use serde_json::{json, Value};

#[tokio::test]
#[ignore = "requires the isolated GUI fixture and its temporary credentials file"]
async fn native_live_connection_to_gui() {
    let path = std::env::var("LIVE_GUI_CONFIG").expect("GUI fixture config required");
    let config: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let input = json!({
        "port": config["port"], "token": config["token"], "instance": config["instance"],
        "file": "", "scene": "Scene", "view_layer": "ViewLayer", "work": "fixture-work"
    });
    let live = Live::default();
    let mut bad_token = input.clone();
    let token = input["token"].as_str().unwrap();
    bad_token["token"] = json!(format!(
        "{}{}",
        if token.starts_with('a') { "b" } else { "a" },
        &token[1..]
    ));
    assert!(command(&live, "connect", bad_token).await.is_err());
    for key in ["instance", "file", "scene", "view_layer"] {
        let mut mismatch = input.clone();
        mismatch[key] = json!("different-target");
        assert!(command(&live, "connect", mismatch).await.is_err());
        assert!(live.0.lock().await.is_none());
    }
    let target = command(&live, "connect", input.clone()).await.unwrap();
    assert_eq!(target["mode"], "live");
    assert_eq!(target["telemetry"], false);
    assert_eq!(target["camera"], "Camera");
    assert!(command(&live, "connect", input.clone()).await.is_err());
    assert!(command(&live, "status", json!({"work":"another-work"}))
        .await
        .is_err());
    let observed = command(
        &live,
        "observe",
        json!({"work":"fixture-work","scope":"summary"}),
    )
    .await
    .unwrap();
    assert_eq!(observed["instance"], target["instance"]);
    assert_eq!(observed["lens"].as_f64(), Some(35.0));
    command(&live, "yield", json!({"work":"fixture-work"})).await.unwrap();
    assert!(command(&live, "resume", json!({"work":"fixture-work","expected":observed})).await.is_err());
    let codex = Live::default();
    command(&codex, "connect", input.clone()).await.unwrap();
    assert!(command(&live, "reclaim", json!({"work":"fixture-work"})).await.is_err());
    command(&codex, "disconnect", Value::Null).await.unwrap();
    let fresh=command(&live, "reclaim", json!({"work":"fixture-work"})).await.unwrap();
    let result=command(&live, "candidate", json!({"work":"fixture-work","expected":fresh,"width":128,"height":96})).await.unwrap();
    assert_eq!(result["state"]["gui_required"],true);
    let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let mut db=rusqlite::Connection::open_in_memory().unwrap();
    manga_llm_contracts::blender::initialize(&db).unwrap();
    let id=uuid::Uuid::new_v4().to_string();
    let stored=manga_llm_contracts::blender::store_live_candidate(&mut db,&root,&id,result).unwrap();
    assert_eq!(stored["state"]["state"]["resolution"],json!([128,96]));
    assert_eq!(manga_llm_contracts::blender::capture(&db,&root,&id,&id).unwrap(),stored);
    std::fs::remove_dir_all(root).unwrap();
    command(&live, "disconnect", Value::Null).await.unwrap();
    assert!(command(&live, "status", json!({"work":"fixture-work"}))
        .await
        .is_err());
    let reconnected = command(&live, "connect", input).await.unwrap();
    assert_eq!(reconnected["instance"], target["instance"]);
    assert_eq!(reconnected["file"], "");
    command(&live, "disconnect", Value::Null).await.unwrap();
}
