//! A dedicated, one-shot Blender CLI session. bpy owns scene/camera/render state.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::{Path,PathBuf}, sync::Mutex, time::Duration};
use tokio::io::AsyncWriteExt;
const WORKER:&str=include_str!("../../blender/worker.py");
fn error()->String {"Blender処理を完了できませんでした。要求状態を確認してください".into()}
fn hash(path:&Path)->Result<String,String> {
    use std::io::Read;
    let mut file=std::fs::File::open(path).map_err(|_|error())?;let mut digest=Sha256::new();let mut buffer=[0u8;65536];
    loop {let n=file.read(&mut buffer).map_err(|_|error())?;if n==0 {break;} digest.update(&buffer[..n]);}
    Ok(format!("{:x}",digest.finalize()))
}
fn canonical(path:&str)->Result<PathBuf,String> {std::fs::canonicalize(path).map_err(|_|"指定パスを開けません".into())}
fn valid_id(id:&str)->bool {id.len()==36 && id.bytes().enumerate().all(|(i,b)| if [8,13,18,23].contains(&i) {b==b'-'} else {b.is_ascii_hexdigit()})}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {pub binary:String,pub library_root:String,pub source:String}
#[derive(Deserialize,Serialize,Clone)]
struct Session {id:String,binary:PathBuf,library:PathBuf,checkpoint:PathBuf,hash:String,revision:u64,state:Value}
#[derive(Deserialize,Serialize,Clone,Copy)]
#[serde(tag="kind",rename_all="lowercase",deny_unknown_fields)]
pub enum Operation { Inspect, Camera{lens:f64}, Capture{width:u32,height:u32} }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {pub session_id:String,pub request_id:String,pub expected_revision:u64,pub operation:Operation}
pub fn initialize(db:&rusqlite::Connection)->Result<(),String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS blender_sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blender_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,expected_revision INTEGER NOT NULL,result TEXT); UPDATE blender_jobs SET status='unknown' WHERE status='running';").map_err(|_|error())
}
pub fn register(db:&rusqlite::Connection,input:Registration)->Result<Value,String> {
    let binary=canonical(&input.binary)?;let library=canonical(&input.library_root)?;let source=canonical(&input.source)?;
    if !binary.is_file() || !library.is_dir() || !source.is_file() || !source.starts_with(&library) || source.extension().and_then(|s|s.to_str())!=Some("blend") {return Err("Blender実行ファイル・認可素材フォルダ・その中のblendを指定してください".into());}
    let id=format!("session-{:x}",Sha256::digest(format!("{}:{:?}",source.display(),std::time::SystemTime::now()).as_bytes()));
    let session=Session{id:id.clone(),binary,library,hash:hash(&source)?,checkpoint:source,revision:0,state:Value::Null};
    db.execute("INSERT INTO blender_sessions(id,data) VALUES(?1,?2)",rusqlite::params![id,serde_json::to_string(&session).map_err(|_|error())?]).map_err(|_|error())?;
    Ok(json!({"session_id":id,"revision":0,"state":null,"verified":false}))
}
fn session(db:&rusqlite::Connection,id:&str)->Result<Session,String> {
    let data:String=db.query_row("SELECT data FROM blender_sessions WHERE id=?1",[id],|r|r.get(0)).map_err(|_|"Blender接続を登録してください")?;
    serde_json::from_str(&data).map_err(|_|error())
}
pub fn status(db:&rusqlite::Connection,id:&str)->Result<Value,String> {
    let session=session(db,id)?;
    let mut statement=db.prepare("SELECT id,status,expected_revision FROM blender_jobs WHERE session_id=?1 ORDER BY rowid DESC LIMIT 20").map_err(|_|error())?;
    let jobs:Vec<Value>=statement.query_map([id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"expected_revision":r.get::<_,u64>(2)?}))).map_err(|_|error())?.collect::<Result<_,_>>().map_err(|_|error())?;
    Ok(json!({"session_id":session.id,"revision":session.revision,"state":session.state,"jobs":jobs}))
}
pub fn latest(db: &rusqlite::Connection) -> Result<Option<Value>, String> {
    use rusqlite::OptionalExtension;
    let id: Option<String> = db.query_row("SELECT id FROM blender_sessions ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0)).optional().map_err(|_|error())?;
    id.map(|id|status(db,&id)).transpose()
}
fn verify_output(folder:&Path)->Result<Value,String> {
    let path=folder.join("result.json");if std::fs::symlink_metadata(&path).map_err(|_|error())?.file_type().is_symlink() || std::fs::metadata(&path).map_err(|_|error())?.len()>1024*1024 {return Err(error());}
    let result:Value=serde_json::from_slice(&std::fs::read(path).map_err(|_|error())?).map_err(|_|error())?;
    if result["protocol"]!=1 || result["blender_version"]!=json!([4,5,13]) {return Err("未対応のBlender版・接続形式です".into());}
    for (key,name) in [("checkpoint","checkpoint.blend"),("image","capture.png")] {
        if key=="image" && result[key].is_null() {continue;}
        let path=folder.join(name);
        if result[key]["file"]!=name || std::fs::symlink_metadata(&path).map_err(|_|error())?.file_type().is_symlink() || result[key]["hash"]!=hash(&path)? {return Err("Blender成果物の検証に失敗しました".into());}
    }
    Ok(result)
}
pub async fn execute(db:&Mutex<rusqlite::Connection>,root:&Path,request:Request)->Result<Value,String> {
    if !valid_id(&request.request_id) {return Err("要求IDが不正です".into());}
    match request.operation {Operation::Camera{lens} if !lens.is_finite() || !(10.0..=250.0).contains(&lens)=>return Err("焦点距離は10〜250mmです".into()),Operation::Capture{width,height} if !(64..=4096).contains(&width) || !(64..=4096).contains(&height)=>return Err("撮影寸法は64〜4096です".into()),_=>{}}
    let mut current={
        let db=db.lock().map_err(|_|error())?;let current=session(&db,&request.session_id)?;
        if current.revision!=request.expected_revision {return Err("Blenderの版が更新されています。状態を再確認してください".into());}
        let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM blender_jobs WHERE session_id=?1 AND status IN ('running','unknown'))",[&request.session_id],|r|r.get(0)).map_err(|_|error())?;
        if pending {return Err("応答未確定のBlender要求があります。状態確認が必要です".into());}
        db.execute("INSERT INTO blender_jobs(id,session_id,status,expected_revision) VALUES(?1,?2,'running',?3)",rusqlite::params![request.request_id,request.session_id,request.expected_revision]).map_err(|_|"送信済みの要求です。自動再実行しません")?;current
    };
    let folder=root.join("blender").join(&request.request_id);
    let result=run(&current,&folder,&request.operation).await;
    let mut db=db.lock().map_err(|_|error())?;
    match result {
        Ok(result)=>{
            if session(&db,&current.id)?.revision!=request.expected_revision {db.execute("UPDATE blender_jobs SET status='candidate',result=?2 WHERE id=?1",rusqlite::params![request.request_id,result.to_string()]).map_err(|_|error())?;return Err("旧版の撮影結果を候補として保持しました".into());}
            current.checkpoint=folder.join("checkpoint.blend");current.hash=result["checkpoint"]["hash"].as_str().ok_or_else(error)?.into();current.revision+=1;current.state=result.clone();
            let tx=db.transaction().map_err(|_|error())?;
            tx.execute("UPDATE blender_sessions SET data=?2 WHERE id=?1",rusqlite::params![current.id,serde_json::to_string(&current).map_err(|_|error())?]).map_err(|_|error())?;
            tx.execute("UPDATE blender_jobs SET status='complete',result=?2 WHERE id=?1",rusqlite::params![request.request_id,result.to_string()]).map_err(|_|error())?;tx.commit().map_err(|_|error())?;
            let mut response=json!({"session_id":current.id,"revision":current.revision,"request_id":request.request_id,"state":result});
            if !response["state"]["image"].is_null() {use base64::Engine;response["preview"]=Value::String(format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(std::fs::read(folder.join("capture.png")).map_err(|_|error())?)));}
            Ok(response)
        },
        Err(e)=>{db.execute("UPDATE blender_jobs SET status='unknown' WHERE id=?1",[request.request_id]).map_err(|_|error())?;Err(e)}
    }
}
async fn run(session:&Session,folder:&Path,operation:&Operation)->Result<Value,String> {
    if hash(&session.checkpoint)?!=session.hash {return Err("Blenderの入力版が変更されています".into());}
    std::fs::create_dir_all(folder.parent().ok_or_else(error)?).map_err(|_|error())?;std::fs::create_dir(folder).map_err(|_|error())?;
    // The executable script is fixed application content, never text from a model or job.
    let script=folder.with_extension("py");std::fs::write(&script,WORKER).map_err(|_|error())?;
    let input=json!({"input":session.checkpoint,"input_hash":session.hash,"library_root":session.library,"output_root":folder,"operation":operation});
    let mut command=tokio::process::Command::new(&session.binary);command.env_clear();
    for name in ["HOME","TMPDIR","PATH","LANG","DISPLAY","XAUTHORITY"] {if let Some(value)=std::env::var_os(name) {command.env(name,value);}}
    command.args(["--background","--factory-startup","--disable-autoexec","--python-exit-code","1","--python"]).arg(&script).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    let mut child=command.spawn().map_err(|_|error())?;let mut stdin=child.stdin.take().ok_or_else(error)?;stdin.write_all(input.to_string().as_bytes()).await.map_err(|_|error())?;drop(stdin);
    let status=tokio::time::timeout(Duration::from_secs(600),child.wait()).await.map_err(|_|error())?.map_err(|_|error())?;
    if !status.success() {return Err(error());}
    let result=verify_output(folder)?;
    for name in ["checkpoint.blend","result.json","capture.png"] {let path=folder.join(name);if path.exists(){std::fs::File::open(path).map_err(|_|error())?.sync_all().map_err(|_|error())?;}}
    std::fs::File::open(folder).map_err(|_|error())?.sync_all().map_err(|_|error())?;
    Ok(result)
}
