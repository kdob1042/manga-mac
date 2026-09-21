import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));

test('model switching persists without inference and a saved job keeps its original model',async({page})=>{
 await page.goto('/');
 await page.evaluate(async fixture=>{await (await import('/src/bridge.js')).saveProject(fixture);},legacy);
 await page.reload();
 await page.getByRole('button',{name:'接続・人物設定',exact:true}).click();
 const select=page.getByLabel('画像生成モデル',{exact:true});
 await select.selectOption('flux-2-klein-4b-q6-local');
 await expect.poll(()=>page.evaluate(async()=>(await (await import('/src/bridge.js')).loadProject()).mediaDefaults.image)).toBe('flux-2-klein-4b-q6-local');
 await page.reload();await page.getByRole('button',{name:'接続・人物設定',exact:true}).click();
 await expect(page.getByLabel('画像生成モデル',{exact:true})).toHaveValue('flux-2-klein-4b-q6-local');
 const result=await page.evaluate(async()=>{
   const {loadProject}=await import('/src/bridge.js');const {beginJob}=await import('/src/revisions.js');
   const {executeImage}=await import('/src/media-runtime.js');const {imageRequest}=await import('/src/image-input.js');
   const p=await loadProject(),job=await beginJob({...p,jobs:[]},p.panels[0]);
   p.mediaDefaults.image='flux-2-klein-4b-local';
   const requests=[];window.__TAURI_INTERNALS__={invoke:async(c,a)=>{requests.push({c,a});return 'result';}};
   const request=imageRequest({panel:p.panels[0],references:[],width:768,height:768,seed:1,job,modelId:job.media.registry_id});
   await executeImage(job.media.registry_id,request);
   let rejected=false;try{await executeImage(p.mediaDefaults.image,request);}catch{rejected=true;}
   return {requests,job,rejected};
 });
 expect(result.job.media.model_id).toBe('flux_2_klein_4b_q6p.ckpt');
 expect(result.requests).toHaveLength(1);expect(result.requests[0].c).toBe('generate_image');
 expect(result.requests[0].a.request.media).toEqual(result.job.media);expect(result.rejected).toBe(true);
});
