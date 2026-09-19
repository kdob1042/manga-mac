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
const report = {status:'running',commit:process.env.GITHUB_SHA??null,model:process.env.DIRECTION_MODEL,real_llm:true,real_blender:true,real_image_model:'not_run',mac_gui:'not_run',production_character_quality:'not_run',checks:[]};
try {
  await connect();
  const base = await call('blender_register',{binary:process.env.BLENDER_BIN,library_root:resolve(process.env.DIRECTION_FIXTURES),source:fixture});
  await call('blender_execute',{request:{session_id:base.session_id,request_id:crypto.randomUUID(),expected_revision:0,operation:{kind:'inspect'}}});
  const baselineState=await call('blender_status',{sessionId:base.session_id});
  const baseline=await call('blender_execute',{request:{session_id:base.session_id,request_id:crypto.randomUUID(),expected_revision:baselineState.revision,operation:{kind:'capture',width:256,height:256}}});
  await writeFile(root+'/baseline-capture.png',Buffer.from(baseline.preview.split(',')[1],'base64'));
  const failures=[];
  report.failures=failures;
  for (let i=0;i<4;i++) {
    try {
    const response = await direct(`p${i}`);
    // Preserve actual output even when semantic assertions fail; image inference is a separate check.
    await writeFile(`${root}/panel-${i}.png`,Buffer.from(response.preview.split(',')[1],'base64'));
    assert.equal(response.state.state.lens,[45,55,65,75][i]);
    console.log(`Panel ${i}: actual capture verified`);
    report.checks.push(`panel ${i}: requested lens and actual capture`);
    } catch(e) { failures.push(`panel ${i}: ${e.message}`); console.error(failures.at(-1)); }
  }
  assert.equal(new Set(project.panels.map(p=>p.shot_binding.session_id)).size,4);
  const capturesSoFar=project.captures??[];
  assert.equal(new Set(capturesSoFar.map(c=>c.image.hash)).size,capturesSoFar.length);
  if (!project.panels[0].capture_revision) throw Error('Natural revision prerequisite failed: panel 0 has no capture');
  const before = structuredClone(project);
  await stop(); start(); await connect();
  project = JSON.parse(await readFile(root+'/project.json','utf8'));
  const revised = await direct('p0','このコマだけ、立方体をもっと大きく写すように寄ってください。人物や照明は変更しない。');
  assert.notDeepEqual(revised.state.state,before.captures[0].settings,'natural-language revision must change the actual camera');
  assert.notEqual(revised.state.image.hash,before.captures[0].image.hash);
  assert.deepEqual(project.panels.slice(1),before.panels.slice(1));
  for (const p of before.panels.slice(1)) {
    if (!p.capture_revision) continue;
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
  report.status = failures.length ? 'fail' : 'pass';
  if(failures.length)process.exitCode=1;
} catch(e) {report.status='fail';report.error=e.stack;process.exitCode=1;}
finally {
  report.llm_calls=calls;
  await writeFile(root+'/acceptance.json',JSON.stringify(report,null,2));
  await stop(); console.log(JSON.stringify(report));
}
