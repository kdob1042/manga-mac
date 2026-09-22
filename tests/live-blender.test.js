import test from 'node:test';
import assert from 'node:assert/strict';
import {directLivePanel,validateLiveDecision,assertLiveTarget,failureKind} from '../src/live-blender.js';
const target={instance:'i',epoch:'e',file:'a.blend',scene:'Scene',view_layer:'ViewLayer'};
const decision=(action,operation=null,scope='summary',object='')=>({action,operation,scope,object,reason:'test'});
function fixture(decisions,{lens=35,stale=false,cancel=()=>false,changed=true,apply=true,properties={},afterWrite,observeAfterWrite,modelError}={}) {
 let project={active:'s',snapshots:[],panels:[{id:'p',snapshotId:'s',prompt:'寄って',live_binding:target}]};
 const original=structuredClone(project);
 let rev=1,calls=[],requests=[],postWriteReads=0;
 const values={lens,camera:'Camera',id:'o',name:'Camera',type:'CAMERA',location:[0,0,0],rotation:[0,0,0],evaluated_world:[[1,0,0,0],[0,1,0,0],[0,0,1,5],[0,0,0,1]],influence:.5,...properties};
 const summary=()=>({...target,revision:rev,control:'ai',lens:values.lens,camera:values.camera,objects:[{name:values.name,id:values.id,type:values.type}]});
 const detail=()=>({...summary(),...structuredClone(values),constraints:[{name:'Track',influence:values.influence}]});
 const call=async(_, {action,input})=>{
   calls.push(action);
   if(action==='resume'||action==='handoff')return summary();
   if(action==='observe'){
     const result=input.scope==='object'?detail():summary();
     return requests.length&&observeAfterWrite?observeAfterWrite(result,++postWriteReads,input.scope):result;
   }
   if(action==='act') {
     requests.push(input);
     if(apply){
       const op=input.operation;
       if(op.kind==='camera')values.lens=op.value;
       if(op.kind==='constraint')values.influence=op.value;
       if(op.kind==='transform')values.location=[...op.location];
       if(op.kind==='rotation')values.rotation=[...op.rotation];
     }
     afterWrite?.(values);rev++;return {...summary(),changed};
   }
   throw Error(action);
 };
 const ask=async()=>{if(modelError)throw modelError;if(stale){rev++;stale=false;}return decisions.shift()??decision('ready');};
 return {run:()=>directLivePanel({current:()=>project,commit:async p=>{project=p;},call,ask,panelId:'p',cancelled:cancel}),calls,requests,original,get project(){return project;}};
}
test('ready without an actual operation is confirmation, not success/capture',async()=>{
 const f=fixture([decision('ready')]);const r=await f.run();assert.equal(r.status,'confirm');assert.equal(f.requests.length,0);assert.equal(f.project.live_directing_runs[0].failure,'visual_unmet');
});
test('object observation then action must reread real state and require confirmation',async()=>{
 const f=fixture([decision('observe',null,'object','Camera'),decision('act',{kind:'camera',object:'Camera',object_id:'o',value:50}),decision('ready')]);
 const r=await f.run();assert.equal(r.status,'confirm');assert.equal(f.requests.length,1);assert.deepEqual(f.calls.slice(f.calls.indexOf('act')+1,f.calls.indexOf('act')+3),['observe','observe']);assert.equal(f.project.live_directing_runs[0].changed_operations,1);
});
test('manual change while model thinks invalidates its unsent plan',async()=>{
 const f=fixture([decision('act',{kind:'camera',object:'Camera',object_id:'o',value:50}),decision('ready')],{stale:true});await f.run();assert.equal(f.requests.length,0);assert.equal(f.project.live_directing_runs[0].steps[0].action,'invalidated');
});
test('old enum exterior constraint operation requires real object and constraint',()=>{
 const d=decision('act',{kind:'constraint',object:'Rig',object_id:'r',constraint:'Track',value:.2});
 assert.equal(validateLiveDecision(d,{name:'Rig',id:'r',constraints:[{name:'Track'}]}),d);
 assert.throws(()=>validateLiveDecision(d,{name:'Rig',id:'r',constraints:[]}),/target_unknown/);
 assert.throws(()=>validateLiveDecision(d,null),/observation_missing/);
});
test('infinite observations stop at 12 and classify model problem',async()=>{
 const f=fixture(Array.from({length:13},()=>decision('observe')));await assert.rejects(f.run(),/12 step/);assert.equal(f.project.live_directing_runs[0].failure,'model_judgment');
});
test('epoch/instance mismatch never resolves by similar name',()=>{
 assert.throws(()=>assertLiveTarget(target,{...target,epoch:'new'}),/target_unknown/);assert.equal(failureKind(Error('execution_unknown: lost')),'execution_unknown');
});

test('cancel is a live pause, never a headless capture result',async()=>{
 const f=fixture([],{cancel:()=>true});assert.deepEqual(await f.run(),{live:true,status:'paused'});assert.equal(f.requests.length,0);
});

test('camera orientation requires observed camera identity and finite vectors',()=>{
 for(const [kind,field] of [['rotation','rotation'],['aim','target']]) {
  const op={kind,object:'Camera',object_id:'o',[field]:[0,1,2]};
  const d=decision('act',op), detail={name:'Camera',id:'o',type:'CAMERA'};
  assert.equal(validateLiveDecision(d,detail),d);
  assert.throws(()=>validateLiveDecision(d,{...detail,type:'MESH'}),/invalid camera/);
  assert.throws(()=>validateLiveDecision(decision('act',{...op,[field]:[NaN,0,0]}),detail),/invalid camera/);
 }
});
test('aim readback checks evaluated camera direction, not the operation reply',async()=>{
 const {cameraAimsAt}=await import('../src/live-blender.js');
 const matrix=[[1,0,0,0],[0,1,0,0],[0,0,1,5],[0,0,0,1]];
 assert.equal(cameraAimsAt(matrix,[0,0,0]),true);
 assert.equal(cameraAimsAt(matrix,[0,0,10]),false);
 assert.equal(cameraAimsAt(matrix,[0,0,5]),false);
 assert.equal(cameraAimsAt(matrix,[2,0,0]),false);
});

const operation=(kind,fields)=>({kind,object:'Camera',object_id:'o',...fields});
const actions=op=>[decision('observe',null,'object','Camera'),decision('act',op),decision('ready')];
const towardsOrigin=[[1,0,0,0],[0,1,0,0],[0,0,1,5],[0,0,0,1]];
const awayFromOrigin=[[-1,0,0,0],[0,1,0,0],[0,0,-1,5],[0,0,0,1]];
for(const [kind,fields] of [
 ['camera',{value:35}],['constraint',{constraint:'Track',value:.5}],['transform',{location:[0,0,0]}],['rotation',{rotation:[0,0,0]}],['aim',{target:[0,0,0]}],
])test(`${kind}: no-op plus changed:true and revision increment is still unchanged`,async()=>{
 const f=fixture(actions(operation(kind,fields)),{changed:true});await f.run();
 const run=f.project.live_directing_runs[0];
 assert.equal(run.changed_operations,0);assert.equal(run.steps.at(-1).changed,false);
 assert.equal(run.failure,'visual_unmet');assert.match(run.message,/未変更/);
 assert.deepEqual(f.project.panels,f.original.panels);assert.equal(f.requests.length,1);
});

for(const [kind,fields,properties,afterWrite] of [
 ['camera',{value:50}],['constraint',{constraint:'Track',value:.8}],['transform',{location:[1,2,3]}],['rotation',{rotation:[0,.5,0]}],
 ['aim',{target:[0,0,0]},{evaluated_world:awayFromOrigin},values=>{values.evaluated_world=towardsOrigin;}],
])test(`${kind}: actual readback proves change even when adapter reports changed:false`,async()=>{
 const f=fixture(actions(operation(kind,fields)),{changed:false,properties,afterWrite});await f.run();
 const run=f.project.live_directing_runs[0];assert.equal(run.changed_operations,1);
 assert.equal(run.steps.at(-1).changed,true);assert.notDeepEqual(run.steps.at(-1).before,run.steps.at(-1).actual);
 assert.deepEqual(f.project.panels,f.original.panels);assert.equal(f.requests.length,1);
});

for(const [kind,fields,properties] of [
 ['camera',{value:50}],['constraint',{constraint:'Track',value:.8}],['transform',{location:[1,2,3]}],['rotation',{rotation:[0,.5,0]}],
 ['aim',{target:[0,0,0]},{evaluated_world:awayFromOrigin}],
])test(`${kind}: a successful response with unapplied values blocks without repeating`,async()=>{
 const f=fixture(actions(operation(kind,fields)),{apply:false,properties});
 await assert.rejects(f.run(),/操作後の実値が一致しません.*詳細調整/);
 const run=f.project.live_directing_runs[0];assert.equal(run.status,'blocked');assert.equal(run.steps.at(-1).status,'pending');
 assert.equal(f.requests.length,1);assert.deepEqual(f.project.panels,f.original.panels);
});

for(const readIndex of [1,2])test(`manual revision change during readback ${readIndex} leaves operation unresolved`,async()=>{
 const f=fixture(actions(operation('camera',{value:50})),{observeAfterWrite:(value,index)=>index===readIndex?{...value,revision:value.revision+1}:value});
 await assert.rejects(f.run(),/stale_observation/);
 assert.equal(f.project.live_directing_runs[0].steps.at(-1).status,'pending');assert.equal(f.requests.length,1);
 assert.equal(f.calls.at(-1),'handoff');
});

for(const patch of [{control:'manual'},{id:'replacement'},{camera:'OtherCamera'}])test(`changed readback identity/control ${JSON.stringify(patch)} cannot certify an operation`,async()=>{
 const f=fixture(actions(operation('camera',{value:50})),{observeAfterWrite:(value,index)=>index===2?{...value,...patch}:value});
 await assert.rejects(f.run(),/stale_observation|target_unknown/);
 assert.equal(f.project.live_directing_runs[0].steps.at(-1).status,'pending');assert.equal(f.requests.length,1);
});

test('missing baseline values stop before any operation and retain prior work',async()=>{
 const f=fixture(actions(operation('transform',{location:[1,2,3]})),{properties:{location:undefined}});
 await assert.rejects(f.run(),/observation_missing.*詳細調整/);assert.equal(f.requests.length,0);
 assert.deepEqual(f.project.panels,f.original.panels);
});

test('API and invalid model failures include actionable guidance and preserve prior work',async()=>{
 for(const options of [{modelError:Error('API unavailable')},{}]){
   const f=fixture([{action:'invalid'}],options);
   await assert.rejects(f.run(),/詳細調整/);
   assert.match(f.project.live_directing_runs[0].message,/詳細調整/);
   assert.deepEqual(f.project.panels,f.original.panels);assert.equal(f.requests.length,0);
   assert.equal(f.calls.at(-1),'handoff');
 }
});
