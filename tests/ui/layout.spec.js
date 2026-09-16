import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('four corners, cancel, undo/redo and six-panel persistence keep artwork and export geometry',async({page})=>{
 await page.goto('/');
 await page.evaluate(async fixture=>{
   const {saveProject}=await import('/src/bridge.js');
   fixture.panels=Array.from({length:6},(_,i)=>({...fixture.panels[0],id:`panel${i}`}));fixture.history=[];
   await saveProject(fixture);
 },legacy);
 await page.reload();await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
 await page.getByLabel('枠数',{exact:true}).selectOption('6');await page.getByRole('button',{name:'テンプレートを適用'}).click();
 await expect(page.getByTestId('layout-slot-5')).toBeVisible();
 // Fill the two new slots by moving existing art from the old partial page.
 for(const i of [4,5]){
   const poly=page.getByTestId(`layout-slot-${i}`);await poly.click({position:{x:60,y:45}});
   await page.getByLabel('選択枠のコマ',{exact:true}).selectOption(`panel${i}`);
   await expect(page.getByLabel('選択枠のコマ',{exact:true})).toHaveCount(0); // committed page resets selection
 }
 await page.getByTestId('layout-slot-0').click({position:{x:60,y:45}});
 const before=await page.getByTestId('layout-slot-0').getAttribute('points');
 for(let i=0;i<4;i++){
   const handle=page.getByTestId(`vertex-${i}`);await handle.scrollIntoViewIfNeeded();const b=await handle.boundingBox();
   await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+(i%2===0?6:-6),b.y+b.height/2+(i<2?6:-6),{steps:5});await page.mouse.up();
   await expect(page.getByRole('button',{name:'枠をUndo'})).toBeEnabled();
   await page.getByTestId('layout-slot-0').click({position:{x:60,y:45}});
 }
 const after=await page.getByTestId('layout-slot-0').getAttribute('points');expect(after).not.toBe(before);
 const h=await page.getByTestId('vertex-0').boundingBox();await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+25,h.y+25);await page.keyboard.press('Escape');await page.mouse.up();
 await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points',after);
 await page.getByRole('button',{name:'枠をUndo'}).click();await expect(page.getByTestId('layout-slot-0')).not.toHaveAttribute('points',after);
 await page.getByRole('button',{name:'枠をRedo'}).click();await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points',after);
 await page.reload();await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points',after);
 const result=await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js');const {pagePNG}=await import('/src/render.js');const {pagePanels}=await import('/src/layout.js');const p=await loadProject(),pg=p.layout.pages[0];return {png:await pagePNG(pagePanels(p,pg),p.snapshots,[], 'ja',pg),image:p.panels[0].image,jobs:p.jobs.length,slots:pg.slots.length};});
 expect(result.image).toBe(legacy.panels[0].image);expect(result.jobs).toBe(0);expect(result.slots).toBe(6);expect(result.png).toMatch(/^data:image\/png;base64,/);
 await page.screenshot({path:'test-results/free-layout-six.png',fullPage:true});
});
