import test from 'node:test';
import assert from 'node:assert/strict';
import {captureAngles} from '../src/live-angles.js';
import {imageHash} from '../src/revisions.js';
const preview='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const target={instance:'i',epoch:'e',file:'/working.blend',scene:'Scene',view_layer:'ViewLayer'};
async function fixture({editAfterFirst=false,stopAfterFirst=false}={}) {
 let p={active:'s',snapshots:[{id:'s',text:'original'}],history:[],panels:[{id:'p',snapshotId:'s',capture_revision:'old',live_binding:target},{id:'other'}]};
 const original=p;let revision=1,stopped=false;const writes=[];const hash=await imageHash(preview);
 const state=()=>({...target,revision,objects:[{id:'o',name:'Actor',type:'MESH'}]});
 const call=async(command,{action,input})=>{
  if(command==='blender_live_candidate') {writes.push(input);revision++;return {session_id:`s${writes.length}`,request_id:`r${writes.length}`,preview,live_observation:state(),state:{dependencies_pinned:true,checkpoint:{hash:'a'.repeat(64)},image:{hash},state:{scene:'Scene'},scenes:[{name:'Scene',objects:['Actor']}]}};}
  if(action==='handoff')return state();
  if(action==='observe')return input.scope==='object'?{...state(),evaluated_world:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]}:state();
  throw Error(action);
 };
 return {run:()=>captureAngles({current:()=>p,commit:async n=>{p=n;if(editAfterFirst&&writes.length===1)revision++;},call,panelId:'p',targetObject:'Actor',cancelled:()=>stopped,onCapture:()=>{if(stopAfterFirst)stopped=true;}}),writes,original,get project(){return p;}};
}
test('three angles create separate candidates without changing adoption, other panels or source',async()=>{
 const f=await fixture();assert.equal((await f.run()).length,3);
 assert.deepEqual(f.writes.map(w=>w.angle.degrees),[-30,0,30]);
 assert.equal(f.project.live_candidates.length,3);assert.equal(f.project.captures.length,3);
 assert.equal(f.project.panels,f.original.panels);assert.equal(f.project.snapshots,f.original.snapshots);
 assert.equal(f.project.panels[0].capture_revision,'old');
});
test('manual change or stop prevents the next capture but preserves completed candidates',async()=>{
 for(const options of [{editAfterFirst:true},{stopAfterFirst:true}]){
  const f=await fixture(options);await assert.rejects(f.run(),/停止/);
  assert.equal(f.writes.length,1);assert.equal(f.project.live_candidates.length,1);assert.equal(f.project.panels[0].capture_revision,'old');
 }
});
