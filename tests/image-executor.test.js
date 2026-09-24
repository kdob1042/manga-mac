import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createImageExecutor} from '../src/image-executor.js';
import {beginJob,finishJob,migrateProject,adoptCandidate} from '../src/revisions.js';
import {imageModels} from '../src/media.js';
const fixture=JSON.parse(readFileSync(new URL('fixtures/legacy-v1.json',import.meta.url)));

test('alternate model AND adapter use the same job, execution gate, candidate and adoption without production registration',async()=>{
 const definitions=[{id:'fixture-a',adapter_id:'fixture-local',model_id:'first'},{id:'fixture-b',adapter_id:'fixture-second',model_id:'second'}];
 const resolve=id=>{const model=definitions.find(m=>m.id===id);if(!model)throw Error('unknown');return model;};
 const execution=id=>{const m=resolve(id);return {registry_id:m.id,adapter_id:m.adapter_id,model_id:m.model_id};};
 const project=await migrateProject(fixture), calls=[];
 const adapters={'fixture-local':async()=>project.panels[0].image,'fixture-second':async()=>project.panels[0].image};
 const execute=createImageExecutor(resolve,async(command,{request})=>{calls.push({command,media:request.media});return adapters[request.media.adapter_id](request);});
 let p=project;
 for(const model of definitions){
  const panel=p.panels[0],job=await beginJob(p,panel,'generate',model.id,execution);
  p={...p,jobs:[...p.jobs,job]};
  const result=await execute(model.id,{media:job.media});
  p=await finishJob(p,job,{...panel,image:result},false,true);
  assert.equal(p.jobs.at(-1).status,'candidate');
  p=await adoptCandidate(p,job.id);
  assert.equal(p.jobs.at(-1).status,'complete');
 }
 assert.deepEqual(calls.map(c=>c.media.adapter_id),['fixture-local','fixture-second']);
 assert.ok(calls.every(c=>c.command==='generate_image'));
 assert.equal(imageModels.some(m=>m.id.startsWith('fixture-')),false);
 const before=calls.length;
 await assert.rejects(()=>execute('fixture-b',{media:execution('fixture-a')}),/一致/);
 assert.equal(calls.length,before,'a changed adapter is rejected before submission');
 assert.equal((await migrateProject(p,true)).artworks.length,p.artworks.length);
});

test('cloud image jobs retain model-specific connections when the current selection changes', async () => {
 const project=await migrateProject(fixture);
 project.mediaDefaults={image:'runway-gen4-image',imageConnection:'legacy-runway',imageConnections:{'openai-gpt-image-2-5':'openai-binding'}};
 const openai=await beginJob(project,project.panels[0],'generate','openai-gpt-image-2-5');
 assert.equal(openai.cloud_connection,'openai-binding');
 assert.equal(openai.media.model_id,'gpt-image-2.5-sunburst');
 assert.equal(openai.cost.currency,'USD');
 const runway=await beginJob(project,project.panels[0],'generate','runway-gen4-image');
 assert.equal(runway.cloud_connection,'legacy-runway');
 assert.equal(runway.cost.currency,'credits');
 delete project.mediaDefaults.imageConnections;
 await assert.rejects(()=>beginJob(project,project.panels[0],'generate','openai-gpt-image-2-5'),/接続/);
});
