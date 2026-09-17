import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('interrupted edit recovers a masked candidate once, never adopts or regenerates', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async legacy => {
    const { migrateProject, beginJob, imageHash, adoptCandidate } = await import('/src/revisions.js');
    const { recoverImageResult } = await import('/src/image-recovery.js');
    const {imageOf}=await import('/src/canvas-image.js');
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0,0,8,8);
    legacy.panels[0].image = canvas.toDataURL();
    const p = await migrateProject(legacy), panel = p.panels[0];
    const job = await beginJob(p, panel, 'edit');
    const restart = await migrateProject({ ...p, jobs: [job] }, true);
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0,0,8,8);
    const image = canvas.toDataURL(), rect = [0.25,0.25,0.5,0.5];
    const context = { version: 1, kind: 'edit', panel: { ...panel, image: null, generation: { width: 8, height: 8 }, instructions: ['口元だけ'] }, original: panel.image, original_hash: await imageHash(panel.image), rect };
    const receipt = { job_id: job.id, input_hash: job.input_hash, context, image, hash: await imageHash(image) };
    const recovered = await recoverImageResult(restart, job.id, receipt);
    ctx.clearRect(0,0,8,8); ctx.drawImage(await imageOf(recovered.artworks.at(-1).panel.image),0,0);
    const bytes = ctx.getImageData(0,0,8,8).data;
    let exact = true;
    for (let y=0;y<8;y++) for (let x=0;x<8;x++) {
      const inner=x>=2&&x<6&&y>=2&&y<6, offset=(y*8+x)*4;
      if (bytes[offset] !== (inner?0:255) || bytes[offset+1] !== 0 || bytes[offset+2] !== (inner?255:0) || bytes[offset+3] !== 255) exact=false;
    }
    let refused=0;
    for (const bad of [{ ...receipt, hash:'bad' },{ ...receipt, input_hash:'bad' },{ ...receipt, context:{...context, original_hash:'bad'} },{ ...receipt, context:{...context, rect:null} },{ ...receipt, context:{...context, panel:{...context.panel,generation:{width:9,height:8}}} }]) {
      try { await recoverImageResult(restart,job.id,bad); } catch { refused++; }
    }
    const stale = await recoverImageResult({ ...restart, active: 'new-source' },job.id,receipt);
    let staleRefused=false; try { await adoptCandidate(stale,job.id); } catch { staleRefused=true; }
    const twice = await recoverImageResult(await migrateProject(recovered,true),job.id,receipt);
    return { exact, refused, staleRefused, candidate: recovered.jobs[0].status, unchanged: JSON.stringify(recovered.panels)===JSON.stringify(restart.panels) && JSON.stringify(recovered.history)===JSON.stringify(restart.history), once: twice.artworks.length===recovered.artworks.length };
  }, structuredClone(legacy));
  expect(results).toEqual({ exact:true, refused:5, staleRefused:true, candidate:'candidate', unchanged:true, once:true });
});

test('unknown image UI collects saved output and keeps adopted image across reload', async ({ page }) => {
  await page.addInitScript(legacy => {
    window.__TAURI_INTERNALS__ = { invoke: async (command,args) => {
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'kdob1042/Kamiya-Kawai',episode:'P01'}]};
      if (command === 'load_project') return sessionStorage.getItem('image-project') || JSON.stringify(legacy);
      if (command === 'save_project') { sessionStorage.setItem('image-project',args.data); return; }
      if (command === 'recover_image') {
        const receipt=JSON.parse(sessionStorage.getItem('image-receipt'));
        if (args.jobId!==receipt.job_id) throw Error('wrong job');
        return receipt;
      }
      throw Error(`Unexpected IPC: ${command}`);
    } };
  }, legacy);
  await page.goto('/');
  await page.evaluate(async legacy => {
    const { migrateProject,beginJob,imageHash }=await import('/src/revisions.js');
    const p=await migrateProject(legacy), panel=p.panels[0], job=await beginJob(p,panel,'retake');
    const image=legacy.history[0].panels[0].image;
    p.jobs=[job];
    sessionStorage.setItem('image-project',JSON.stringify(p));
    sessionStorage.setItem('image-receipt',JSON.stringify({job_id:job.id,input_hash:job.input_hash,image,hash:await imageHash(image),context:{version:1,kind:'retake',panel:{...panel,image:null,generation:{width:2,height:2}}}}));
  },legacy);
  await page.reload();
  await page.locator('.art').click();
  await page.getByRole('button',{name:'保存済み作画を回収する',exact:true}).click();
  await expect(page.getByRole('img',{name:'新しい作画候補',exact:true})).toBeVisible();
  await expect(page.locator('.art img')).toHaveAttribute('src',legacy.panels[0].image);
  await page.screenshot({path:'test-results/image-recovery-candidate.png',fullPage:true});
  await page.reload();
  await page.locator('.art').click();
  await expect(page.getByRole('img',{name:'新しい作画候補',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'保存済み作画を回収する',exact:true})).toHaveCount(0);
  await expect(page.locator('.art img')).toHaveAttribute('src',legacy.panels[0].image);
});
