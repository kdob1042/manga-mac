import test from 'node:test';
import assert from 'node:assert/strict';
import { directPanel, validateDirection } from '../src/directing.js';
const hash = 'a'.repeat(64);
const state = { dependencies_pinned: true, checkpoint: { hash }, operations: ['catalog','camera','shot','pose','transform','aim','light','import','capture'],
  state: { scene: 'Scene', camera: 'Camera', lens: 35, frame: 1, resolution: [768,768] },
  scenes: [{ name: 'Scene', cameras: ['Camera'], objects: ['Actor','Camera','Light'] }], rigs: ['Actor'],
  objects: [{ name: 'Actor', type: 'ARMATURE', editable: true }, { name: 'Camera', type: 'CAMERA', editable: true }, { name: 'Light', type: 'LIGHT', editable: true }],
  assets: [{ kind: 'ACTION', name: 'Lean', library: null }], library_assets: [] };
const action = operation => ({ status: 'action', reason: '演出を調整', operation });
test('unknown targets, code, capabilities, unsafe numbers and unsourced imports are rejected',()=>{
  const s={state};
  for(const op of [{kind:'python',code:'anything'}, {kind:'camera',lens:NaN}, {kind:'camera',lens:70,code:'x'},
    {kind:'transform',object:'Missing',location:[0,0,0],rotation:[0,0,0]},
    {kind:'aim',location:[0,0,0],target:[0,0,0],lens:50},
    {kind:'import',file:'unknown.blend',hash,asset_type:'OBJECT',name:'Actor'},
    {kind:'light',object:'Light',energy:-1,color:[1,1,1]}]) assert.throws(()=>validateDirection(action(op),s));
  assert.doesNotThrow(()=>validateDirection(action({kind:'pose',rig:'Actor',action:'Lean',frame:1}),s));
});

test('unbound and legacy shots require GUI assignment without starting or querying headless',async()=>{
 for(const shot_binding of [undefined,{session_id:'old'}]) {
  let calls=0;
  await assert.rejects(directPanel({current:()=>({panels:[{id:'p',shot_binding}]}),panelId:'p',call:async()=>{calls++;}}),/GUI/);
  assert.equal(calls,0);
 }
});
