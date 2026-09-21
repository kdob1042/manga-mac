import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));

test('external editor candidate can be adopted and reopened without Compositor installed',async({page})=>{
 await page.goto('/');
 await page.evaluate(async input=>{
  const {saveProject}=await import('/src/bridge.js'),{migrateProject}=await import('/src/revisions.js');
  const {beginCompositor,finishCompositor,rasterBundle,compositorRevision}=await import('/src/compositor.js');
  const p=await migrateProject(input),panel=p.panels[0],job=await beginCompositor(p,panel),bundle=rasterBundle(panel.image,1,1);
  p.jobs.push(job);
  await saveProject(await finishCompositor(p,job,{bundle,image:panel.image,upstream_revision:compositorRevision,state:{document:bundle.manifest.documentID,revision:3,owner:'app',layers:bundle.manifest.layers}}));
 },fixture);
 await page.reload();await page.locator('.panel').first().click();
 await expect(page.getByRole('button',{name:'この候補を採用',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'この候補を採用',exact:true}).click();
 await page.reload();await page.locator('.panel').first().click();
 const saved=await page.evaluate(async()=>await(await import('/src/bridge.js')).loadProject());
 expect(saved.panels[0].compositor.bundle.manifest.version).toBe(8);
 await page.getByText('外部レイヤー編集（Compositor）',{exact:true}).click();
 await expect(page.getByRole('button',{name:'レイヤー編集を始める',exact:true})).toBeDisabled();
 await expect(page.locator('.art img').first()).toHaveAttribute('src',fixture.panels[0].image);
});
