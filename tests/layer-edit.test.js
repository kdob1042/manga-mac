import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {colourPixels,validateColourEdit,colourRequest} from '../src/layer-edit.js';
import {migrateProject,imageHash} from '../src/revisions.js';
import {defaultImageModelId} from '../src/media.js';
const rgba=JSON.parse(readFileSync(new URL('fixtures/layered.json',import.meta.url)));

test('colour-only edit preserves original alpha, transparent pixels and every out-of-range channel',()=>{
 const before=Uint8ClampedArray.from([20,40,60,128, 90,80,70,0, 10,30,50,255, 1,2,3,255]);
 const generated=Uint8ClampedArray.from([255,0,0,255, 0,255,0,255, 0,0,255,0, 9,8,7,0]);
 const result=colourPixels(before,generated,2,2,[0,0,1,.5]);
 assert.deepEqual([...result],[255,0,0,128,90,80,70,0,10,30,50,255,1,2,3,255]);
 assert.throws(()=>validateColourEdit([.8,0,.5,1],'#ffffff'),/範囲/);
 assert.throws(()=>validateColourEdit([0,0,1,1],'turn left'),/色/);
});

test('target, lettering-free context and confirmed character references are actual pinned inputs',async()=>{
 const input=JSON.parse(readFileSync(new URL('fixtures/legacy-v1.json',import.meta.url)));
 input.panels[0].image=rgba.original;input.panels[0].characterIds=['person'];
 input.characters=[{id:'person',name:'人物',image:rgba.layers[0],hash:await imageHash(rgba.layers[0])}];
 const project=await migrateProject(input),panel=project.panels[0];
 const capture={layer:'layer',state:{width:256,height:256,instance:'instance',document:'document',revision:3},target:rgba.layers[1],context:rgba.original};
 const {job,request}=await colourRequest(project,panel,'session',capture,'person',[0,0,1,1],'#3366cc',defaultImageModelId);
 assert.equal(request.original,capture.target);assert.deepEqual(request.references.map(r=>r.role),['context','character']);
 assert.deepEqual(request.references.map(r=>r.image),[capture.context,project.characters[0].image]);
 assert.equal(job.layer_edit.source.revision,3);assert.equal(job.layer_edit.runtime.helper_contract,2);
 await assert.rejects(()=>colourRequest(project,panel,'session',capture,'unknown',[0,0,1,1],'#3366cc',defaultImageModelId),/人物/);
});

test('named movement requires one confirmed person and layer; unsupported edits fail closed',async()=>{
 const {planLayerMove}=await import('../src/layer-edit.js');
 const project={characters:[{id:'a',name:'神谷'}],panels:[{id:'p',characterIds:['a']}]},job={panelId:'p',status:'running',compositor:{bindings:{l:'a'}}};
 const state={owner:'app',width:400,height:400,layers:[{id:'l',raster:true,visible:true,x:100,y:100,width:50,height:80,rotation:0}]};
 assert.equal(planLayerMove(project,job,state,'神谷を少し左へ').x,90);
 assert.throws(()=>planLayerMove(project,job,state,'神谷を左に向かせて'),/未対応/);
 assert.throws(()=>planLayerMove(project,job,{...state,owner:'human'},'神谷を少し左へ'),/操作権/);
 assert.throws(()=>planLayerMove({...project,characters:[...project.characters,{id:'a',name:'神谷'}]},job,state,'神谷を少し左へ'),/一つ/);
});
