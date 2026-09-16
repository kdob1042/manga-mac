import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { directPanel } from '../../src/directing.js';
import { emptyProject } from '../../src/core.js';

const root = resolve(process.env.DIRECTION_RESULTS);
await mkdir(root, {recursive:true});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = resolve(process.env.DIRECTION_FIXTURES, 'fixture.blend');
const original = sha(await readFile(fixture));
let bridge, lines, calls = 0;
function start() {
  bridge = spawn(resolve('tests/llm/target/debug/direction_bridge'), [], {stdio:['pipe','pipe','inherit']});
  lines = createInterface({input:bridge.stdout})[Symbol.asyncIterator]();
}
async function call(command, args = {}) {
  bridge.stdin.write(JSON.stringify({command,args})+'\n');
  const line = await lines.next();
  assert.ok(!line.done, 'native bridge stopped unexpectedly');
  const response = JSON.parse(line.value);
  if (response.error) throw Error(response.error);
  return response.value;
}
async function stop() {
  const exited = new Promise(resolve => bridge.once('exit', resolve));
  bridge.stdin.end(); await exited;
}
start();
let project = {...emptyProject(),active:'synthetic',snapshots:[{id:'synthetic',scenes:[{id:'scene',text:'A cube on a stage.\n\nA second view.\n\nA third view.\n\nA fourth view.'}],settings:[]}],
  panels:[45,55,65,75].map((lens,i)=>({id:`p${i}`,snapshotId:'synthetic',sceneId:'scene',unitIds:[`scene:u${i}`],characterIds:[],prompt:`撮影済みの立方体を撮る。カメラの焦点距離だけを${lens}mmに変更。他は変更しない。既に${lens}mmなら撮影可能。`,image:null}))};
const commit = async p => {project = structuredClone(p); await writeFile(root+'/project.json',JSON.stringify(project,null,2));};
const transcript = [];
let connection;
async function connect() {
  connection = await call('llm_register',{provider:'ollama',purpose:'plan',endpoint:'http://127.0.0.1:11434',model:process.env.DIRECTION_MODEL,credential:'',json_mode:true});
}
const ask = async (prompt,schema) => {
  assert.ok(++calls <= 30, 'real model call budget exceeded');
  const started = Date.now();
  const record = {prompt,started}; transcript.push(record);
  try {
    const value = await call('llm_request',{connection_id:connection,purpose:'direction',request_id:crypto.randomUUID(),prompt,schema,images:[]});
    record.response = value; record.elapsed_ms = Date.now()-started;
    console.log(`LLM ${calls}: ${value.status} ${JSON.stringify(value.operation)} (${record.elapsed_ms}ms)`);
    return value;
  } catch(e) {record.error = e.message; throw e;}
  finally {await writeFile(root+'/transcript.json',JSON.stringify(transcript,null,2));}
};
const direct = (panelId,instruction='') => directPanel({current:()=>project,commit,call,ask,panelId,instruction});
const report = {status:'running',model:process.env.DIRECTION_MODEL,real_llm:true,real_blender:true,real_image_model:'not_run',mac_gui:'not_run',production_character_quality:'not_run',checks:[]};
try {
  await connect();
  const base = await call('blender_register',{binary:process.env.BLENDER_BIN,library_root:resolve(process.env.DIRECTION_FIXTURES),source:fixture});
  await call('blender_execute',{request:{session_id:base.session_id,request_id:crypto.randomUUID(),expected_revision:0,operation:{kind:'inspect'}}});
  for (let i=0;i<4;i++) {
    const response = await direct(`p${i}`);
    // Preserve actual output even when semantic assertions fail; image inference is a separate check.
    await writeFile(`${root}/panel-${i}.png`,Buffer.from(response.preview.split(',')[1],'base64'));
    assert.equal(response.state.state.lens,[45,55,65,75][i]);
    console.log(`Panel ${i}: actual capture verified`);
  }
  assert.equal(new Set(project.panels.map(p=>p.shot_binding.session_id)).size,4);
  assert.equal(new Set(project.captures.map(c=>c.image.hash)).size,4);
  report.checks.push('four independent shots: requested lens and distinct real renders');
  const before = structuredClone(project);
  await stop(); start(); await connect();
  project = JSON.parse(await readFile(root+'/project.json','utf8'));
  const revised = await direct('p0','このコマだけもっと寄ってください。焦点距離を90mmに変更し、それ以外は変更しない。既に90mmなら完了。');
  assert.equal(revised.state.state.lens,90);
  assert.notEqual(revised.state.image.hash,before.captures[0].image.hash);
  assert.deepEqual(project.panels.slice(1),before.panels.slice(1));
  for (const p of before.panels.slice(1)) {
    const s = await call('blender_status',{sessionId:p.shot_binding.session_id});
    const old = before.captures.find(c=>c.id===p.capture_revision);
    assert.equal(s.state.checkpoint.hash,old.checkpoint.hash);
  }
  await writeFile(root+'/panel-0-revised.png',Buffer.from(revised.preview.split(',')[1],'base64'));
  report.checks.push('native restart and single-panel natural-language revision; other checkpoints unchanged');
  const captures = project.captures.length;
  await assert.rejects(direct('p1','素材に存在しない人物MissingActorのリグと歩行ポーズが必要です。代用や新規作成は禁止。不足する場合は不足を報告し停止してください。'));
  assert.equal(project.directing_runs.at(-1).status,'blocked');
  assert.equal(project.captures.length,captures);
  assert.equal(sha(await readFile(fixture)),original);
  report.checks.push('missing asset blocked without capture; source file unchanged');
  report.status = 'pass';
} catch(e) {report.status='fail';report.error=e.stack;process.exitCode=1;}
finally {
  report.llm_calls=calls;
  await writeFile(root+'/acceptance.json',JSON.stringify(report,null,2));
  await stop(); console.log(JSON.stringify(report));
}
