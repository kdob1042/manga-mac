import test from 'node:test';
import assert from 'node:assert/strict';
import {createScene,validateScene,applySceneOperation,updatePanelScene} from '../src/scene-model.js';
import {undoEdit} from '../src/edit-commands.js';

const actor={id:'player',assetId:'person',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};
const assets=new Set(['person']);
test('typed scene operations remain isolated to one panel and share persisted undo and redo',()=>{
  const other={id:'other',image:'approved'},panel={id:'first',image:'art'};
  const project={panels:[panel,other],layout:{pages:[]},history:[],sceneAssets:[{id:'person'}]};
  const a=updatePanelScene(project,'first',{type:'add',object:actor});
  assert.equal(a.panels[0].scene3d.objects[0].id,'player');
  assert.equal(a.panels[1],other);
  const b=updatePanelScene(a,'first',{type:'transform',id:'player',position:[2,0,-3]});
  assert.deepEqual(b.panels[0].scene3d.objects[0].position,[2,0,-3]);
  assert.deepEqual(undoEdit(b).panels[0].scene3d,a.panels[0].scene3d);
  assert.deepEqual(undoEdit(undoEdit(b),true).panels[0].scene3d,b.panels[0].scene3d);
  assert.equal(JSON.parse(JSON.stringify(b)).panels[1].image,'approved');
});

test('reject unregistered or malformed GLB references, nonfinite transforms, duplicate IDs and dangling contact targets',()=>{
  const base=createScene();
  assert.throws(()=>applySceneOperation(base,{type:'add',object:actor},new Set()),/不正/);
  const a=applySceneOperation(base,{type:'add',object:actor},assets);
  assert.throws(()=>applySceneOperation(a,{type:'add',object:actor},assets),/不正/);
  assert.throws(()=>applySceneOperation(a,{type:'transform',id:'player',position:[Infinity,0,0]},assets),/不正/);
  assert.throws(()=>applySceneOperation(a,{type:'pose',id:'player',contacts:[{type:'ball_attach',targetId:'absent',hand:'right'}]},assets),/不正/);
  assert.throws(()=>validateScene({...a,camera:{...a.camera,fov:NaN}},assets),/不正/);
  assert.equal(a.objects.length,1);
});

test('basketball setup replaces a full shot atomically and rejects unsupported input before history changes',()=>{
  const project={panels:[{id:'court'}],layout:{pages:[]},history:[],sceneAssets:[{id:'person'}]};
  const scene={...createScene(),objects:[{...actor,airborne:true,pose:{bones:{rightArm:[.2,0,0]}}}]};
  const next=updatePanelScene(project,'court',{type:'replace',scene});
  assert.equal(next.history.length,1);
  assert.equal(next.panels[0].scene3d.objects[0].airborne,true);
  assert.throws(()=>updatePanelScene(project,'court',{type:'replace',scene:{...scene,objects:[{...actor,assetId:'unknown'}]}}),/不正/);
  assert.equal(project.history.length,0);
});
