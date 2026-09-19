//! Test-only stdio adapter. Calls production registries and Blender persistence directly.
use manga_llm_contracts::{blender, llm};
use serde_json::{json, Value};
use std::{io::{self, BufRead, Write}, path::PathBuf, sync::Mutex};

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key].as_str().ok_or_else(|| format!("missing {key}"))
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(std::env::var("DIRECTION_RESULTS")?);
    std::fs::create_dir_all(&root)?;
    let db = rusqlite::Connection::open(root.join("blender.sqlite"))?;
    blender::initialize(&db)?;
    let db = Mutex::new(db);
    let connections = llm::Connections::default();
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let result = dispatch(&request, &db, &root, &connections).await;
        println!("{}", match result { Ok(value) => json!({"value":value}), Err(error) => json!({"error":error}) });
        io::stdout().flush()?;
    }
    Ok(())
}
async fn dispatch(v: &Value, db: &Mutex<rusqlite::Connection>, root: &std::path::Path, connections: &llm::Connections) -> Result<Value, String> {
    let args = &v["args"];
    match field(v, "command")? {
        "llm_register" => Ok(json!(connections.register(serde_json::from_value(args.clone()).map_err(|e|e.to_string())?).await?)),
        "llm_request" => Ok(connections.request(serde_json::from_value(args.clone()).map_err(|e|e.to_string())?).await?.value),
        "blender_execute" => blender::execute(db, root, serde_json::from_value(args["request"].clone()).map_err(|e|e.to_string())?).await,
        command => {
            let mut db = db.lock().map_err(|e| e.to_string())?;
            match command {
                "blender_register" => blender::register(&db, serde_json::from_value(args.clone()).map_err(|e|e.to_string())?),
                "blender_latest" => Ok(json!(blender::latest(&db)?)),
                "blender_status" => blender::status(&db, field(args,"sessionId")?),
                "blender_fork" => Ok(json!(blender::fork_shots(&mut db, field(args,"sessionId")?, args["expectedRevision"].as_u64().ok_or("revision")?, serde_json::from_value(args["ids"].clone()).map_err(|e|e.to_string())?)?)),
                "blender_capture" => blender::capture(&db, root, field(args,"sessionId")?, field(args,"requestId")?),
                _ => Err("unsupported test command".into()),
            }
        }
    }
}
