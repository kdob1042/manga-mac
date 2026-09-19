import test from 'node:test';
import assert from 'node:assert/strict';
import { directPanel, validateDirection, abandonDirection, MAX_DIRECTION_STEPS } from '../src/directing.js';
import { imageHash } from '../src/revisions.js';
import { emptyProject } from '../src/core.js';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const hash = 'a'.repeat(64);
const state = { dependencies_pinned: true, checkpoint: { hash }, operations: ['catalog','camera','shot','pose','transform','aim','light','import','capture'],
  state: { scene: 'Scene', camera: 'Camera', lens: 35, frame: 1, resolution: [768,768] },
  scenes: [{ name: 'Scene', cameras: ['Camera'], objects: ['Actor','Camera','Light'] }], rigs: ['Actor'],
  objects: [{ name: 'Actor', type: 'ARMATURE', editable: true }, { name: 'Camera', type: 'CAMERA', editable: true }, { name: 'Light', type: 'LIGHT', editable: true }],
  assets: [{ kind: 'ACTION', name: 'Lean', library: null }], library_assets: [] };
const action = operation => ({ status: 'action', reason: '演出を調整', operation });
const ready = { status: 'ready', reason: '撮影へ進む', operation: null };
async function fixture() {
  let project = { ...emptyProject(), active: 's', snapshots: [{ id: 's', scenes: [{ id: 'scene', text: 'A\n\nB\n\nC\n\nD' }], settings: [] }], panels: Array.from({length:4},(_,i)=>({id:`p${i}`,snapshotId:'s',sceneId:'scene',unitIds:[`scene:u${i}`],characterIds:[],prompt:'synthetic',image:null})) };
  const sessions = new Map(), calls = [];
  let lose = false;
  const call = async (command, args) => {
    calls.push({ command, args });
    if (command === 'blender_latest') return { session_id: 'base', revision: 0, state };
    if (command === 'blender_fork') return args.ids.map(id => { const s = { session_id: id, revision: 0, state: structuredClone(state), jobs: [] }; sessions.set(id, s); return structuredClone(s); });
    if (command === 'blender_status') return structuredClone(sessions.get(args.sessionId));
    if (command === 'blender_capture') { const s = sessions.get(args.sessionId); return { ...structuredClone(s), request_id: args.requestId }; }
    if (command === 'blender_execute') {
      const r = args.request, s = sessions.get(r.session_id);
      assert.equal(r.expected_revision,s.revision);
      assert.ok(!s.jobs.some(j=>j.id===r.request_id));
      s.revision++; s.jobs.push({id:r.request_id,status:'complete'});
      if (r.operation.kind === 'camera') s.state.state.lens = r.operation.lens;
      if (r.operation.kind === 'capture') { s.preview = image; s.state.image = {hash:await imageHash(image)}; }
      if (lose && r.operation.kind === 'camera') { lose=false; throw Error('connection lost after execution'); }
      return { ...structuredClone(s), request_id:r.request_id };
    }
    throw Error('unexpected command');
  };
  return { current:()=>project, commit:async p=>{project=structuredClone(p);}, call, sessions, calls, lose:()=>{lose=true;} };
}
test('four panels automatically fork, direct, capture and retain independent source/scope', async()=>{
  const f = await fixture();
  for(let i=0;i<4;i++) {
    let step=0;
    await directPanel({...f,panelId:`p${i}`,ask:async()=>step++ ? ready : action({kind:'camera',lens:40+i})});
  }
  assert.equal(f.current().captures.length,4);
  assert.equal(new Set(f.current().panels.map(p=>p.shot_binding.session_id)).size,4);
  assert.ok(f.current().directing_runs.every(r=>r.status==='complete'));
  assert.equal(f.calls.filter(x=>x.args?.request?.operation.kind==='capture').length,4);
  assert.equal(f.current().snapshots[0].scenes[0].text,'A\n\nB\n\nC\n\nD');
  assert.equal(state.state.lens,35);
});
test('lost response resumes by reading native completion without repeating camera operation', async()=>{
  const f = await fixture(); f.lose();
  await assert.rejects(directPanel({...f,panelId:'p0',ask:async()=>action({kind:'camera',lens:70})}),/lost/);
  assert.equal(f.current().directing_runs[0].steps.at(-1).status,'pending');
  await directPanel({...f,panelId:'p0',ask:async()=>ready});
  assert.equal(f.calls.filter(x=>x.args?.request?.operation.kind==='camera').length,1);
  assert.equal(f.current().captures.length,1);
});
test('source change, pending native request and cancellation prevent new operations', async()=>{
  const f=await fixture();
  let stop=false;
  await directPanel({...f,panelId:'p0',cancelled:()=>stop,ask:async()=>{stop=true;return action({kind:'camera',lens:70});}});
  assert.equal(f.current().directing_runs[0].status,'paused');
  assert.equal(f.calls.filter(x=>x.args?.request?.operation.kind==='camera').length,0);
  const p=f.current(); await f.commit({...p,active:'different'});
  await assert.rejects(directPanel({...f,panelId:'p0',ask:async()=>ready}),/原作/);
});
test('missing assets block without capture; an abandoned plan can be replaced explicitly', async()=>{
  const f=await fixture();
  await assert.rejects(directPanel({...f,panelId:'p0',ask:async()=>({status:'blocked',reason:'図書館の素材がありません',operation:null})}),/図書館/);
  assert.equal(f.current().captures?.length??0,0);
  await f.commit(abandonDirection(f.current(),f.current().directing_runs[0].id));
  await directPanel({...f,panelId:'p0',ask:async()=>ready});
  assert.equal(f.current().captures.length,1);
});
test('unknown targets, code, capabilities, unsafe numbers and unsourced imports are rejected',()=>{
  const s={state};
  for(const op of [{kind:'python',code:'anything'}, {kind:'camera',lens:NaN}, {kind:'camera',lens:70,code:'x'},
    {kind:'transform',object:'Missing',location:[0,0,0],rotation:[0,0,0]},
    {kind:'aim',location:[0,0,0],target:[0,0,0],lens:50},
    {kind:'import',file:'unknown.blend',hash,asset_type:'OBJECT',name:'Actor'},
    {kind:'light',object:'Light',energy:-1,color:[1,1,1]}]) assert.throws(()=>validateDirection(action(op),s));
  assert.doesNotThrow(()=>validateDirection(action({kind:'pose',rig:'Actor',action:'Lean',frame:1}),s));
});
test('bounded directing loop stops instead of infinite AI retries',async()=>{
  const f=await fixture(); let n=0;
  await assert.rejects(directPanel({...f,panelId:'p0',ask:async()=>action({kind:'camera',lens:40+n++})}),/上限/);
  assert.equal(f.calls.filter(x=>x.args?.request?.operation.kind==='camera').length,MAX_DIRECTION_STEPS);
  assert.equal(f.current().captures?.length??0,0);
});


test('rejects premature ready until the explicit lens goal matches live state', async()=>{
  const f=await fixture();
  f.current().panels[0].prompt='撮影済みの立方体を撮る。カメラの焦点距離だけを45mmに変更。他は変更しない。既に45mmなら撮影可能。';
  let calls=0;
  await directPanel({...f,panelId:'p0',ask:async()=>{
    calls++;
    if(calls===1) return ready;
    if(calls===2) return action({kind:'camera',lens:45});
    return ready;
  }});
  assert.equal(calls,3);
  assert.equal(f.calls.filter(x=>x.args?.request?.operation.kind==='camera').length,1);
  assert.equal(f.current().captures.length,1);
  assert.equal(f.current().directing_runs[0].completionCorrections,1);

  const g=await fixture();
  g.current().panels[0].prompt='撮影済みの立方体を撮る。カメラの焦点距離だけを45mmに変更。他は変更しない。既に45mmなら撮影可能。';
  await assert.rejects(
    directPanel({...g,panelId:'p0',ask:async()=>ready}),
    /完了を報告しましたが、現在状態が目標と一致しません/
  );
  assert.equal(g.current().captures?.length??0,0);
});

test('one semantic correction never repeats a native operation and a second repeat stops', async()=>{
  const f=await fixture(); let calls=0;
  await directPanel({...f,panelId:'p0',ask:async()=>++calls<=2?action({kind:'camera',lens:70}):ready});
  assert.equal(calls,3);
  assert.equal(f.calls.filter(x=>x.args?.request?.operation.kind==='camera').length,1);
  assert.equal(f.current().captures.length,1);
  const g=await fixture(); let repeats=0;
  await assert.rejects(directPanel({...g,panelId:'p0',ask:async()=>{repeats++;return action({kind:'camera',lens:70});}}),/繰り返し/);
  assert.equal(repeats,3);
  assert.equal(g.calls.filter(x=>x.args?.request?.operation.kind==='camera').length,1);
  assert.equal(g.current().captures?.length??0,0);
});

test('a natural-language revision cannot complete on ready without a real change', async()=>{
  const f=await fixture(); let calls=0;
  const before=structuredClone(f.current());
  await assert.rejects(directPanel({...f,panelId:'p0',instruction:'もっと寄って',ask:async()=>{calls++;return ready;}}), /変更を確認できません/);
  assert.equal(calls,2);
  assert.equal(f.current().captures?.length??0,0);
  assert.deepEqual(f.current().panels.slice(1),before.panels.slice(1));
  assert.deepEqual(f.current().snapshots,before.snapshots);
  assert.match(f.current().directing_runs[0].message,/詳細調整/);
});

test('revision-only success metadata cannot disguise a camera operation that did not apply', async()=>{
  const f=await fixture();
  const call=async(command,args)=>{
    if(command==='blender_execute' && args.request.operation.kind==='camera') {
      const result=await f.call(command,args);
      f.sessions.get(args.request.session_id).state.state.lens=35;
      return result;
    }
    return f.call(command,args);
  };
  await assert.rejects(directPanel({...f,call,panelId:'p0',instruction:'もっと寄って',ask:async()=>action({kind:'camera',lens:70})}),/読戻し/);
  assert.equal(f.current().captures?.length??0,0);
  assert.equal(f.current().directing_runs[0].steps.at(-1).status,'pending');
  // Resume must verify the saved operation, not silently accept its completed job.
  await assert.rejects(directPanel({...f,call,panelId:'p0',ask:async()=>ready}),/読戻し/);
  assert.equal(f.calls.filter(c=>c.args?.request?.operation.kind==='camera').length,1);
});

test('a corrected natural-language revision captures only after live state changes', async()=>{
  const f=await fixture(); let calls=0;
  await directPanel({...f,panelId:'p0',instruction:'少し引いて',ask:async()=>{
    calls++;
    return calls===2?action({kind:'camera',lens:28}):ready;
  }});
  assert.equal(calls,3);
  assert.equal(f.current().captures.length,1);
});

test('an original numeric direction cannot certify a new relative revision', async()=>{
  const f=await fixture();
  f.current().panels[0].prompt='レンズを35mmにする';
  await assert.rejects(directPanel({...f,panelId:'p0',instruction:'もっと寄って',ask:async()=>ready}),/変更を確認できません/);
  assert.equal(f.current().captures?.length??0,0);
});

test('a no-op camera job does not count as a change and cannot pass after resume', async()=>{
  const f=await fixture(); let calls=0;
  await assert.rejects(directPanel({...f,panelId:'p0',instruction:'もっと寄って',ask:async()=>++calls===1?action({kind:'camera',lens:35}):ready}),/変更を確認できません/);
  assert.equal(f.current().captures?.length??0,0);
  await assert.rejects(directPanel({...f,panelId:'p0',ask:async()=>ready}),/変更を確認できません/);
  assert.equal(f.calls.filter(c=>c.args?.request?.operation.kind==='camera').length,1);
});


test('numeric lens goals are applied deterministically before asking the model', async()=> {
  const f=await fixture();
  f.current().panels[0].prompt='撮影済みの立方体を撮る。カメラの焦点距離だけを45mmに変更。他は変更しない。既に45mmなら撮影可能。';
  let calls=0;
  await directPanel({...f,panelId:'p0',ask:async()=>{calls++;return ready;}});
  assert.equal(calls,1);
  assert.equal(f.calls.filter(x=>x.args?.request?.operation.kind==='camera').length,1);
  assert.equal(f.sessions.get('p0').state.state.lens,45);
  assert.equal(f.current().captures.length,1);
});
