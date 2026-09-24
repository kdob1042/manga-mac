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
    fixture.panels=Array.from({length:10},(_,i)=>({...fixture.panels[0],id:`panel-${i}`,image:i===8?null:canvas.toDataURL()}));
    const mixed=template(3,fixture.panels.slice(7).map(p=>p.id));
    mixed[0].points[0][0]+=.03;
    fixture.layout={version:1,knownPanelIds:fixture.panels.map(p=>p.id),pages:[
      {id:'full',slots:template(1,['panel-0'])},
      {id:'six',slots:template(6,fixture.panels.slice(1,7).map(p=>p.id))},
      {id:'mixed',slots:mixed},
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
  await page.locator('.thumbnail').nth(2).click();
  await expect(page.getByRole('button',{name:/コマ目を選択/})).toHaveCount(3);
  await expect.poll(()=>proof.getAttribute('src')).toBe(await expected(2));
  await page.getByRole('button',{name:'2コマ目を選択'}).click();
  await expect(page.getByRole('img',{name:'部分修正する元画像'})).toHaveCount(0);
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
  await page.getByRole('button',{name:'作画',exact:true}).first().click();
  const slot=page.getByTestId('art-slot-5');
  const before=await slot.getAttribute('points');
  const baseline=await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js');return loadProject();});
  await page.getByTestId('art-handle-1').scrollIntoViewIfNeeded();
  const handle=await page.getByTestId('art-handle-1').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
  await page.mouse.down();
  await page.mouse.move(handle.x+handle.width/2-8,handle.y+handle.height/2,{steps:3});
  await expect(slot).not.toHaveAttribute('points',before);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(slot).toHaveAttribute('points',before);
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
  await page.mouse.down();
  await page.mouse.move(handle.x+handle.width/2-12,handle.y+handle.height/2,{steps:5});
  await expect(slot).not.toHaveAttribute('points',before); // the frame follows the pointer before saving
  await page.mouse.up();
  await expect(slot).not.toHaveAttribute('points',before);
  await expect(page.getByRole('button',{name:'作画',exact:true}).first()).toHaveAttribute('aria-pressed','true');
  await expect.poll(async()=>{const p=await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js');return loadProject();});return p.layout.pages[1].slots[5].points.map(([x,y])=>`${x*1600},${y*2260}`).join(' ');}).not.toBe(before);
  const saved=await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js');return loadProject();});
  expect(saved.layout.pages[1].slots[5].panelId).toBe('panel-6');
  expect(saved.layout.pages[0]).toEqual(baseline.layout.pages[0]);
  expect(saved.layout.pages[2]).toEqual(baseline.layout.pages[2]);
  expect(saved.panels).toEqual(baseline.panels);
  await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
  await page.getByRole('button',{name:'枠をUndo'}).click();
  await expect(page.getByTestId('layout-slot-5')).toHaveAttribute('points',before);
});
