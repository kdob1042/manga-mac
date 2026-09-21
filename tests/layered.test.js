import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {migrateProject,imageHash} from '../src/revisions.js';
import {layeredRequest,layersToBundle} from '../src/layered.js';
import {imageModels,layeredModels} from '../src/media.js';
const source=JSON.parse(readFileSync(new URL('fixtures/legacy-v1.json',import.meta.url)));
const rgba=JSON.parse(readFileSync(new URL('fixtures/layered.json',import.meta.url)));

test('layer decomposition pins the original input, model, output kind and count',async()=>{
 const input=structuredClone(source);input.panels[0].image=rgba.original;
 const p=await migrateProject(input),panel=p.panels[0],model=layeredModels[0].id;
 const {job,request}=await layeredRequest(p,panel,model,2,256,256,4);
 assert.equal(request.media.model_id,'qwen_image_layered_1.0_bf16_q6p.ckpt');
 assert.deepEqual(request.references,[]);assert.equal(request.original,rgba.original);assert.equal(job.layered.layer_count,2);
 assert.equal(imageModels.some(m=>m.id===model),false,'a layer model is not an ordinary RGB generation option');
 const layers=await Promise.all(rgba.layers.map(async(image,index)=>({index,image,hash:await imageHash(image)})));
 const receipt={kind:'ordered-rgba-layers',job_id:job.id,input_hash:job.input_hash,context:request.recovery,layers};
 const bundle=await layersToBundle(job,receipt);
 assert.equal(bundle.manifest.layers.length,3);assert.equal(bundle.manifest.layers[0].isVisible,false);
 assert.equal(bundle.images[bundle.manifest.layers[0].imageFile].image,rgba.original);
 assert.deepEqual(bundle.manifest.layers.slice(1).map(l=>bundle.images[l.imageFile].image),rgba.layers);
 await assert.rejects(()=>layersToBundle(job,{...receipt,layers:[...layers].reverse()}),/順序/);
 await assert.rejects(()=>layersToBundle(job,{...receipt,layers:layers.slice(0,1)}),/一致/);
 await assert.rejects(()=>layeredRequest(p,panel,model,7,256,256),/レイヤー数/);
 await assert.rejects(()=>layeredRequest(p,panel,model,2,512,512),/同じ寸法/);
 await assert.rejects(()=>layeredRequest(p,panel,imageModels[0].id,2,256,256),/分解/);
});
