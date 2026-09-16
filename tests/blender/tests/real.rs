use manga_blender_contracts::{initialize, register, status, execute, Registration, Request, Operation};
use std::{path::PathBuf,sync::Mutex};
#[tokio::test]
async fn actual_blender_ipc_preserves_source_commits_verified_output_and_reopens_state() {
    let binary=std::env::var("BLENDER_BIN").expect("Real Blender gate requires BLENDER_BIN");
    let fixtures=PathBuf::from(std::env::var("BLENDER_FIXTURES").expect("Real Blender gate requires BLENDER_FIXTURES"));
    let root=fixtures.join("rust-state");std::fs::create_dir(&root).unwrap();
    let db=rusqlite::Connection::open(root.join("test.sqlite3")).unwrap();initialize(&db).unwrap();
    let source=fixtures.join("fixture.blend");let original=std::fs::read(&source).unwrap();
    let input=Registration{binary,library_root:fixtures.to_string_lossy().into(),source:source.to_string_lossy().into()};
    let registered=register(&db,input).unwrap();let id=registered["session_id"].as_str().unwrap().to_string();let db=Mutex::new(db);
    let inspect=execute(&db,&root,Request{session_id:id.clone(),request_id:"00000000-0000-4000-8000-000000000001".into(),expected_revision:0,operation:Operation::Inspect}).await.unwrap();
    assert_eq!(inspect["revision"],1);assert_eq!(inspect["state"]["blender_version"],serde_json::json!([4,5,13]));
    let camera=execute(&db,&root,Request{session_id:id.clone(),request_id:"00000000-0000-4000-8000-000000000002".into(),expected_revision:1,operation:Operation::Camera{lens:80.0}}).await.unwrap();
    assert_eq!(camera["state"]["state"]["lens"],80.0);
    let capture=execute(&db,&root,Request{session_id:id.clone(),request_id:"00000000-0000-4000-8000-000000000003".into(),expected_revision:2,operation:Operation::Capture{width:128,height:128}}).await.unwrap();
    assert!(capture["preview"].as_str().unwrap().starts_with("data:image/png;base64,"));
    assert!(execute(&db,&root,Request{session_id:id.clone(),request_id:"00000000-0000-4000-8000-000000000003".into(),expected_revision:3,operation:Operation::Inspect}).await.is_err());
    assert!(execute(&db,&root,Request{session_id:id.clone(),request_id:"00000000-0000-4000-8000-000000000004".into(),expected_revision:0,operation:Operation::Inspect}).await.is_err());
    assert_eq!(std::fs::read(source).unwrap(),original);
    drop(db);
    let db=rusqlite::Connection::open(root.join("test.sqlite3")).unwrap();initialize(&db).unwrap();let resumed=status(&db,&id).unwrap();assert_eq!(resumed["revision"],3);assert_eq!(resumed["jobs"].as_array().unwrap().len(),3);
}
