import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));

test('art page uses the saved export geometry and selects panels without changing the proof',async({page})=>{
  await page.goto('/');
  await page.evaluate(async fixture=>{
    const {saveProject}=await import('/src/bridge.js');
    const {template}=await import('/src/layout.js');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=100;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#89aacc';ctx.fillRect(0,0,100,100);
    fixture.panels=Array.from({length:7},(_,i)=>({...fixture.panels[0],id:`panel-${i}`,image:canvas.toDataURL()}));
    fixture.layout={version:1,knownPanelIds:fixture.panels.map(p=>p.id),pages:[
      {id:'full',slots:template(1,['panel-0'])},
      {id:'six',slots:template(6,fixture.panels.slice(1).map(p=>p.id))},
    ]};
    fixture.history=[];fixture.jobs=[];
    await saveProject(fixture);
    localStorage.clear();
  },legacy);
  await page.reload();
  const proof=page.getByRole('img',{name:'作画ページの確認'});
  await expect(proof).toBeVisible();
  const expected=async index=>page.evaluate(async i=>{
    const {loadProject}=await import('/src/bridge.js');
    const {pagePanels}=await import('/src/layout.js');
    const {pagePNG}=await import('/src/render.js');
    const project=await loadProject(),target=project.layout.pages[i];
    return pagePNG(pagePanels(project,target),project.snapshots,project.localizations,project.output_locale,target,true,project.layout.imageCrops);
  },index);
  expect(await proof.getAttribute('src')).toBe(await expected(0));
  await expect(page.getByRole('button',{name:'1コマ目を選択'})).toHaveCount(1);
  await page.locator('.thumbnail').nth(1).click();
  await expect(page.getByRole('button',{name:'6コマ目を選択'})).toBeVisible();
  await expect.poll(()=>proof.getAttribute('src')).toBe(await expected(1));
  await page.getByRole('button',{name:'6コマ目を選択'}).click();
  await expect(page.getByRole('button',{name:'6コマ目を選択'})).toHaveAttribute('aria-pressed','true');
  expect(await proof.getAttribute('src')).toBe(await expected(1));
  const original=page.getByRole('img',{name:'部分修正する元画像'});
  await expect(original).toBeVisible();
  await original.scrollIntoViewIfNeeded();
  const box=await original.boundingBox();
  await page.mouse.move(box.x+box.width*.15,box.y+box.height*.1);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*.4,box.y+box.height*.35);
  await page.mouse.up();
  await expect(page.locator('.art-original-image .region')).toBeVisible();
  await page.getByRole('button',{name:'仕上げ',exact:true}).click();
  const final=page.getByRole('img',{name:'書き出しページの確認'});
  await expect(final).toBeVisible();
  expect(await final.getAttribute('src')).toBe(await expected(1));
});
