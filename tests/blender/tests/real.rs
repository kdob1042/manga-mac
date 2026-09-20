use manga_blender_contracts::{execute, initialize, Operation, Request};
use std::sync::Mutex;
#[tokio::test]
async fn legacy_execution_never_starts_a_process() {
 let db=rusqlite::Connection::open_in_memory().unwrap();initialize(&db).unwrap();
 let root=std::env::temp_dir().join("manga-disabled-headless-test");
 let result=execute(&Mutex::new(db),&root,Request{session_id:"old".into(),request_id:"00000000-0000-4000-8000-000000000001".into(),expected_revision:0,operation:Operation::Inspect}).await;
 assert!(result.unwrap_err().contains("GUI"));
}
