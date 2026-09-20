import test from 'node:test';
import assert from 'node:assert/strict';
import {adoptLiveCandidate} from '../src/live-candidates.js';
import {handoffLive,directLivePanel} from '../src/live-blender.js';

test('candidate adoption changes only target and keeps a panel undo snapshot',()=>{
 const a={id:'a',snapshotId:'s',capture_revision:'old',shot_binding:{id:'old'},artwork_revision:'art'},b={id:'b',capture_revision:'other'};
 const candidate={id:'c',panel_id:'a',source_revision:'s',base_capture:'old',base_binding:{id:'old'},shot_binding:{id:'new'},capture_revision:'new',status:'candidate'};
 const p={panels:[a,b],history:[],live_candidates:[candidate],snapshots:[{text:'original'}]};
 const n=adoptLiveCandidate(p,'c');assert.equal(n.panels[1],b);assert.equal(n.panels[0].artwork_revision,'art');assert.equal(n.history[0].panels,p.panels);assert.equal(n.snapshots,p.snapshots);assert.equal(a.capture_revision,'old');
 assert.throws(()=>adoptLiveCandidate(n,'c'),/基準版/);
});
test('handoff during model request discards the unsent action and returns live pause',async()=>{
 const target={instance:'i',epoch:'e',file:'',scene:'s',view_layer:'v'};
 let p={active:'source',panels:[{id:'p',snapshotId:'source',live_binding:target}],snapshots:[]};
 let release,started;const waiting=new Promise(r=>{started=r;});let writes=0;
 const call=async(_, {action})=>{if(action==='act')writes++;return {...target,revision:1,control:'ai',objects:[]};};
 const running=directLivePanel({current:()=>p,commit:async v=>{p=v;},call,panelId:'p',ask:async()=>{started();return new Promise(r=>{release=r;});}});
 await waiting;await handoffLive(call,p);release({action:'act',reason:'obsolete',scope:'summary',object:'',operation:{kind:'camera',object:'C',object_id:'1',value:50}});
 assert.deepEqual(await running,{live:true,status:'paused'});assert.equal(writes,0);
});

test('renamed live character requires explicit reassignment, then keeps its identity',async()=>{
 const {createLiveBinding,verifyLiveMappings}=await import('../src/live-blender.js');
 const panel={shot_binding:{id:'shot'},live_binding:{epoch:'e',objects:[{id:'1',name:'Old'}]}};
 const p={character_bindings:[{shot_id:'shot',character_id:'hero',object_name:'Old'}]};
 const observation={epoch:'e',objects:[{id:'1',name:'New'},{id:'2',name:'New.001'}]};
 assert.throws(()=>verifyLiveMappings(p,panel,observation),/target_unknown/);
 panel.live_binding=createLiveBinding(p,panel,observation);
 assert.equal(panel.live_binding.character_objects[0].object_name,'New');
 assert.doesNotThrow(()=>verifyLiveMappings(p,panel,observation));
 assert.throws(()=>verifyLiveMappings(p,panel,{...observation,objects:[{id:'2',name:'New'}]}),/target_unknown/);
});

test('GUI candidate registration preserves old adoption and maps newly assigned live characters',async()=>{
 const {recordLiveCandidate}=await import('../src/live-candidates.js');
 const {imageHash}=await import('../src/revisions.js');
 const preview='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
 const base={id:'p',snapshotId:'s',capture_revision:'old',live_binding:{character_objects:[{character_id:'hero',object_name:'Actor',object_id:'1'}]}};
 const p={panels:[base,{id:'other'}],history:[],snapshots:[{id:'s',text:'original'}]};
 const response={session_id:'new',request_id:'r',preview,state:{dependencies_pinned:true,checkpoint:{hash:'a'.repeat(64)},image:{hash:await imageHash(preview)},state:{scene:'Scene'},scenes:[{name:'Scene',objects:['Actor']}]}};
 const n=await recordLiveCandidate(p,'p',response,base);
 assert.equal(n.panels,p.panels);assert.equal(n.history,p.history);assert.equal(n.snapshots,p.snapshots);
 assert.equal(n.captures[0].character_bindings[0].object_name,'Actor');
 const adopted=adoptLiveCandidate(n,n.live_candidates[0].id);
 assert.equal(adopted.panels[0].capture_revision,'capture:r');assert.equal(adopted.history.at(-1).panels[0].capture_revision,'old');
 await assert.rejects(recordLiveCandidate(p,'p',{...response,preview:'data:image/png;base64,AAAA'},base),/検証/);
});

test('Codex yield invalidates a pending model plan before releasing MCP ownership',async()=>{
 const {yieldLive}=await import('../src/live-blender.js');
 const target={instance:'i',epoch:'e',file:'',scene:'s',view_layer:'v'};
 let p={active:'source',panels:[{id:'p',snapshotId:'source',live_binding:target}],snapshots:[]};
 let release,started;const waiting=new Promise(r=>{started=r;});const calls=[];
 const call=async(_, {action})=>{calls.push(action);return {...target,revision:1,control:'ai',objects:[]};};
 const running=directLivePanel({current:()=>p,commit:async v=>{p=v;},call,panelId:'p',ask:async()=>{started();return new Promise(r=>{release=r;});}});
 await waiting;await yieldLive(call,p);release({action:'ready',reason:'old',scope:'summary',object:'',operation:null});
 assert.equal((await running).status,'paused');assert.ok(calls.includes('yield'));assert.ok(!calls.includes('act'));
});
