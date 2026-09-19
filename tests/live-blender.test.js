import test from 'node:test';
import assert from 'node:assert/strict';
import {directLivePanel,validateLiveDecision,assertLiveTarget,failureKind} from '../src/live-blender.js';
const target={instance:'i',epoch:'e',file:'a.blend',scene:'Scene',view_layer:'ViewLayer'};
const decision=(action,operation=null,scope='summary',object='')=>({action,operation,scope,object,reason:'test'});
function fixture(decisions,{lens=35,stale=false,cancel=()=>false}={}) {
 let project={active:'s',snapshots:[],panels:[{id:'p',snapshotId:'s',prompt:'寄って',live_binding:target}]};
 let rev=1,calls=[],requests=[];
 const summary=()=>({...target,revision:rev,control:'ai',lens,objects:[{name:'Camera',id:'o',type:'CAMERA'}]});
 const detail=()=>({...summary(),id:'o',name:'Camera',type:'CAMERA',constraints:[{name:'Track',influence:.5}]});
 const call=async(_, {action,input})=>{
   calls.push(action);
   if(action==='resume')return summary();
   if(action==='observe')return input.scope==='object'?detail():summary();
   if(action==='act') {requests.push(input);lens=input.operation.value;rev++;return {...summary(),changed:true};}
   throw Error(action);
 };
 const ask=async()=>{if(stale){rev++;stale=false;}return decisions.shift()??decision('ready');};
 return {run:()=>directLivePanel({current:()=>project,commit:async p=>{project=p;},call,ask,panelId:'p',cancelled:cancel}),calls,requests,get project(){return project;}};
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
