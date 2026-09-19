import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
const mp4='data:video/mp4;base64,'+readFileSync(new URL('../fixtures/video-blue.mp4.base64',import.meta.url),'utf8').trim();
test('assigned motion plays inside the home clip and enlarge shows the full video',async({page})=>{
 await page.goto('/');
 await page.evaluate(async ({legacy,mp4})=>{
  const {saveProject}=await import('/src/bridge.js');
  const {migrateProject}=await import('/src/revisions.js');
  const {shotFromPanel,assignMotion}=await import('/src/panel-motion.js');
  const {beginVideoJob,collectVideoResult,adoptVideoCandidate}=await import('/src/video.js');
  let p=await migrateProject(legacy);
  p=await shotFromPanel(p,p.panels[0].id,'動く','960:960');
  const started=await beginVideoJob(p,p.videoShots.at(-1).id,{id:'test',provider:'runway',model:'gen4.5'});
  p=collectVideoResult(started.project,started.job.id,{artifact_id:'a'.repeat(64),hash:'a'.repeat(64),mime:'video/mp4',size:1838});
  p=await adoptVideoCandidate(p,started.job.id,async()=>{});
  p=await assignMotion(p,p.panels[0].id,p.videoShots.at(-1).id);
  window.__MOTION_SRC__={[p.panelMotions[0].videoRevision]:mp4};
  await saveProject(p);
 },{legacy,mp4});
 await page.reload();
 await page.evaluate(mp4=>{
  return (async()=>{
   const {loadProject}=await import('/src/bridge.js');
   const p=await loadProject();
   window.__MOTION_SRC__={[p.panelMotions[0].videoRevision]:mp4};
  })();
 },mp4);
 await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
 const overlay=page.getByTestId(`page-video-${legacy.panels[0].id}`);
 await expect(overlay).toBeVisible();
 const clip=await overlay.evaluate(el=>getComputedStyle(el).clipPath||el.style.clipPath);
 expect(clip).toMatch(/polygon/i);
 await page.getByTestId('layout-slot-0').click({position:{x:60,y:45}});
 await page.getByRole('button',{name:'動画の全体を表示'}).click();
 const full=page.getByTestId('panel-video-full');
 await expect(full).toBeVisible();
 const fullClip=await full.evaluate(el=>getComputedStyle(el).clipPath);
 expect(fullClip==='none'||fullClip==='').toBeTruthy();
 const fit=await full.evaluate(el=>getComputedStyle(el).objectFit);
 expect(fit).toBe('contain');
});
