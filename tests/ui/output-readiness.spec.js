import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/name-plan-v2-project.json',import.meta.url)));

async function project(page,variant){
 await page.goto('/');
 return page.evaluate(async({p,variant})=>{
  const c=document.createElement('canvas');c.width=200;c.height=200;const ctx=c.getContext('2d');ctx.fillStyle='#dce9dd';ctx.fillRect(0,0,200,200);
  p.panels.forEach(panel=>{panel.image=c.toDataURL();panel.artwork_revision=null;});p.history=[];p.jobs=[];p.artworks=[];
  const {migrateProject}=await import('/src/revisions.js');p=await migrateProject(p);
  p.panels.forEach(panel=>{panel.letteringStatus='ready';panel.letteringArtworkRevision=panel.artwork_revision;});
  const slots=p.layout.pages[0].slots;p.layout.pages=slots.map((slot,i)=>({id:`page:${i}`,slots:[{...slot,points:[[.05,.05],[.95,.05],[.95,.95],[.05,.95]]}]}));
  const target=p.panels.find(panel=>panel.requiredText?.length);
  if(variant==='missing-image')target.image=null;
  if(variant==='stale')target.letteringArtworkRevision='old';
  if(variant==='missing-text')target.lettering.boxes=[];
  if(variant==='pending')target.letteringStatus='draft';
  return {p,target:target.id};
 },{p:fixture,variant});
}

test('finished PNG CBZ and Live reject missing or stale required lettering while drafts and other pages remain usable',async({page})=>{
 for(const variant of ['ready','missing-text','stale','pending']){
  const {p}=await project(page,variant);
  const result=await page.evaluate(async p=>{
   const {pagePNG}=await import('/src/render.js'),{exportCBZ}=await import('/src/export.js'),{prepareLiveManga}=await import('/src/live-export.js'),{pagePanels}=await import('/src/layout.js');
   const second=p.layout.pages[1];const run=async fn=>{try{await fn();return 'ok';}catch(e){return e.message;}};
   return {png:await run(()=>pagePNG(pagePanels(p,second),p.snapshots,[],'ja',second,false)),cbz:await run(()=>exportCBZ(p)),live:await run(()=>prepareLiveManga(p,()=>{throw Error('no video');})),draft:await run(()=>pagePNG(pagePanels(p,second),p.snapshots,[],'ja',second,true)),first:await run(()=>pagePNG(pagePanels(p,p.layout.pages[0]),p.snapshots,[],'ja',p.layout.pages[0],false))};
  },p);
  expect(result.draft).toBe('ok');expect(result.first).toBe('ok');
  for(const key of ['png','cbz','live'])if(variant==='ready')expect(result[key]).toBe('ok');else expect(result[key]).toMatch(variant==='missing-text'?/掲載文字の欠落/:/文字配置が未完了/);
 }
});

test('export issues lead to the correct page and production stage; an unrelated unfinished page does not block current PNG',async({page})=>{
 const incomplete=await project(page,'missing-image');
 await page.evaluate(async p=>await (await import('/src/bridge.js')).saveProject(p),incomplete.p);await page.reload();
 await page.getByText('書き出す',{exact:true}).click();
 await expect(page.getByText('未作画のコマです',{exact:true})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'PNG',exact:true}).click();expect((await download).suggestedFilename()).toBe('page-1-ja.png');
 await page.getByRole('button',{name:'2ページ · 1コマ目を修正',exact:true}).click();
 await expect(page.getByRole('button',{name:'作画',exact:true})).toHaveAttribute('aria-pressed','true');
 const stale=await project(page,'stale');
 await page.evaluate(async p=>await (await import('/src/bridge.js')).saveProject(p),stale.p);await page.reload();
 await page.getByText('書き出す',{exact:true}).click();await page.getByRole('button',{name:'2ページ · 1コマ目を修正',exact:true}).click();
 await expect(page.getByRole('button',{name:'仕上げ',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByLabel('仕上げるコマ',{exact:true})).toHaveValue(stale.target);
 await expect(page.getByRole('status').filter({hasText:'文字配置が未完了、または現在の作画に対応していません'})).toBeVisible();
});
