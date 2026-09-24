import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('reference finishing preserves crop and lettering, compares pages, persists and undoes',async({page})=>{
 await page.addInitScript(legacy=>{
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      if (command === 'acceptance_context') return null;
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'example/story',episode:'P01'}]};
   if(command==='load_project')return sessionStorage.getItem('finish-project')||JSON.stringify(legacy);
   if(command==='save_project'){sessionStorage.setItem('finish-project',args.data);return;}
   if(command==='backup_status')return {config:null,status:{},restored:[]};
   if(command==='generate_image'){
    sessionStorage.setItem('finish-request',JSON.stringify(args.request));
    const c=document.createElement('canvas');c.width=args.request.width;c.height=args.request.height;const ctx=c.getContext('2d');ctx.fillStyle='#ccddee';ctx.fillRect(0,0,c.width,c.height);return c.toDataURL();
   }
   throw Error(`Unexpected IPC: ${command}`);
  }};
 },legacy);
 await page.goto('/');
 await page.evaluate(async()=>{
  const {loadProject,saveProject}=await import('/src/bridge.js');const p=await loadProject();
  p.layout.imageCrops={[p.panels[0].id]:{zoom:1.25,x:.4,y:.6}};
  await saveProject(p);
 });
 await page.reload();await page.getByRole('button',{name:'作画',exact:true}).click();await page.locator('.art-page-targets polygon').first().click();
 await page.getByRole('navigation',{name:'漫画の制作工程'}).getByRole('button',{name:'仕上げ'}).click();
 const before=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('finish-project')));
 await expect(page.getByRole('status').filter({hasText:'必要サイズがエンジン上限'})).toBeVisible();
 await page.getByRole('button',{name:'元画像を参照して仕上げ候補を作る',exact:true}).click();
 await expect(page.getByRole('img',{name:'配置した仕上げ候補',exact:true})).toBeVisible();
 const request=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('finish-request')));
 expect(request.width).toBe(1024);expect(request.height).toBe(1024);
 expect(request.original).toMatch(/^data:image\/png/);expect(request.references.length).toBeGreaterThan(0);
 expect(request.recovery.panel.finishing.parent_revision).toBe(before.panels[0].artwork_revision);
 expect(request.recovery.panel.lettering).toEqual(before.panels[0].lettering);
 await page.screenshot({path:'test-results/placement-finishing.png',fullPage:true});
 await page.reload();await page.getByRole('button',{name:'作画',exact:true}).click();await page.locator('.art-page-targets polygon').first().click();
 await page.getByRole('navigation',{name:'漫画の制作工程'}).getByRole('button',{name:'仕上げ'}).click();
 await page.getByRole('button',{name:'この仕上げ候補を採用',exact:true}).click();
 await expect(page.getByRole('button',{name:'この仕上げ候補を採用',exact:true})).toHaveCount(0);
 const after=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('finish-project')));
 expect(after.layout).toEqual(before.layout);expect(after.snapshots).toEqual(before.snapshots);expect(after.panels[0].lettering).toEqual(before.panels[0].lettering);
 expect(after.jobs.at(-1).status).toBe('complete');expect(after.panels[0].image).not.toBe(before.panels[0].image);
 await page.getByRole('button',{name:'↶ 元に戻す',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('finish-project')).panels[0].image)).toBe(before.panels[0].image);
});

test('saved finishing recovery ignores JSON property order, rejects changed contract and stale crop',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async legacy=>{
  const {migrateProject,imageHash,adoptCandidate}=await import('/src/revisions.js');
  const {beginFinishing}=await import('/src/finishing.js');
  const {recoverImageResult}=await import('/src/image-recovery.js');
  const p=await migrateProject(legacy),panel=p.panels[0],job=await beginFinishing(p,panel.id,1,1);
  const c=document.createElement('canvas');c.width=job.finishing.width;c.height=job.finishing.height;const image=c.toDataURL();
  const context={version:1,kind:'retake',panel:{...panel,image:null,finishing:Object.fromEntries(Object.entries(job.finishing).reverse()),generation:{width:c.width,height:c.height}}};
  const receipt={job_id:job.id,input_hash:job.input_hash,context,image,hash:await imageHash(image)};
  const restarted=await migrateProject({...p,jobs:[job]},true);
  const recovered=await recoverImageResult(restarted,job.id,receipt);
  let invalid=false,stale=false;
  try{await recoverImageResult(restarted,job.id,{...receipt,context:{...context,panel:{...context.panel,finishing:{...job.finishing,width:512}}}});}catch{invalid=true;}
  recovered.layout.imageCrops={[panel.id]:{zoom:2,x:.5,y:.5}};
  try{await adoptCandidate(recovered,job.id);}catch{stale=true;}
  return {invalid,stale,status:recovered.jobs[0].status,unchanged:recovered.panels[0].image===panel.image};
 },legacy);
 expect(result).toEqual({invalid:true,stale:true,status:'candidate',unchanged:true});
});
