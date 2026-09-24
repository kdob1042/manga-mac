import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));

async function openFixture(page){
 await page.goto('/');
 await page.evaluate(async fixture=>{
  const {saveProject}=await import('/src/bridge.js');
  fixture.panels=Array.from({length:2},(_,i)=>({...fixture.panels[0],id:`frame-${i}`}));
  fixture.layout={version:1,knownPanelIds:fixture.panels.map(p=>p.id),pages:[{id:'frames',slots:[
   {id:'a',panelId:'frame-0',points:[[.1,.1],[.7,.1],[.8,.5],[.1,.5]]},
   {id:'b',panelId:'frame-1',points:[[.1,.6],[.8,.6],[.8,.9],[.1,.9]]},
  ]}]};
  fixture.history=[];fixture.jobs=[];await saveProject(fixture);localStorage.clear();
 },legacy);
 await page.reload();await expect(page.getByTestId('art-slot-0')).toBeVisible();
}
async function readProject(page){return page.evaluate(async()=> (await import('/src/bridge.js')).loadProject());}
async function drag(page,locator,dx,dy){
 await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
 await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:5});
}

test('normal interior drags only select; edges snap and preserve margins; Option explicitly moves',async({page})=>{
 await openFixture(page);const slot=page.getByTestId('art-slot-0');
 const before=await readProject(page),initial=await slot.getAttribute('points');
 await drag(page,slot,30,20);await page.mouse.up();
 await expect(slot).toHaveAttribute('points',initial);
 expect((await readProject(page)).layout).toEqual(before.layout);
 const box=await page.locator('.art-page-targets').boundingBox();
 // The slanted edge's lower endpoint snaps to the other panel's right margin.
 await drag(page,page.getByTestId('art-handle-1'),-4,0);
 await expect(page.locator('.frame-snap-guide')).not.toHaveCount(0);
 await page.mouse.up();await expect(slot).toHaveAttribute('points',initial);
 // A larger resize slides endpoints along the horizontal margin lines.
 await drag(page,page.getByTestId('art-handle-1'),-45,0);await page.mouse.up();
 await expect(slot).not.toHaveAttribute('points',initial);
 await expect.poll(async()=> (await readProject(page)).layoutHistory?.length).toBe(1);
 const resized=await readProject(page),points=resized.layout.pages[0].slots[0].points;
 expect(points[1][1]).toBe(.1);expect(points[2][1]).toBe(.5);
 expect(points[0]).toEqual([.1,.1]);expect(points[3]).toEqual([.1,.5]);
 expect(resized.panels).toEqual(before.panels);expect(resized.jobs).toEqual(before.jobs);
 expect(resized.layout.pages[0].slots[1]).toEqual(before.layout.pages[0].slots[1]);
 await page.keyboard.down('Alt');await drag(page,slot,20,15);await page.mouse.up();await page.keyboard.up('Alt');
 await expect.poll(async()=> (await readProject(page)).layoutHistory.length).toBe(2);
 const moved=(await readProject(page)).layout.pages[0].slots[0].points;
 expect(moved[0][0]).toBeCloseTo(points[0][0]+20/box.width,5);
 expect(moved[3][1]-moved[0][1]).toBeCloseTo(points[3][1]-points[0][1],8);
 await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
 const layoutSlot=page.getByTestId('layout-slot-0'),saved=await layoutSlot.getAttribute('points');
 await drag(page,layoutSlot,30,20);await page.mouse.up();await expect(layoutSlot).toHaveAttribute('points',saved);
 await drag(page,page.getByTestId('edge-1'),-30,0);await page.keyboard.press('Escape');await page.mouse.up();
 await expect(layoutSlot).toHaveAttribute('points',saved);
 await drag(page,page.getByTestId('edge-1'),-30,0);await page.mouse.up();
 await expect(layoutSlot).not.toHaveAttribute('points',saved);
 await page.getByRole('button',{name:'枠をUndo'}).click();await expect(layoutSlot).toHaveAttribute('points',saved);
 await page.reload();await expect(page.getByTestId('art-slot-0')).toHaveAttribute('points',saved);
});

test('shrinking and redrawing a frame never collapses the page viewport or jumps its scroll position',async({page})=>{
 await openFixture(page);await page.getByTestId('art-slot-0').click();
 const frame=page.locator('.page-proof-frame');
 await page.getByTestId('art-handle-2').scrollIntoViewIfNeeded();
 const baseline=await frame.boundingBox();
 await page.evaluate(()=>{
  // Slow actual image decoding so the async redraw boundary is observable.
  const OriginalImage=window.Image;
  window.Image=class extends OriginalImage {set onload(callback){super.onload=event=>setTimeout(()=>callback.call(this,event),180);}};
  window.frameSamples=[];
  window.frameObserver=new MutationObserver(()=>{
   const element=document.querySelector('.page-proof-frame');
   window.frameSamples.push({height:element?.getBoundingClientRect().height??0,scroll:document.querySelector('main').scrollTop});
  });
  window.frameObserver.observe(document.querySelector('main'),{subtree:true,childList:true,attributes:true});
 });
 const scroll=await page.locator('main').evaluate(el=>el.scrollTop);
 await drag(page,page.getByTestId('art-handle-2'),0,-80);await page.mouse.up();
 await expect(page.getByTestId('art-slot-0')).toBeVisible();
 await expect.poll(async()=> (await readProject(page)).layoutHistory?.length).toBe(1);
 await expect(frame.locator('.page-proof')).toBeVisible();
 const samples=await page.evaluate(()=>{window.frameObserver.disconnect();return window.frameSamples;});
 expect(samples.length).toBeGreaterThan(0);
 expect(Math.min(...samples.map(s=>s.height))).toBeCloseTo(baseline.height,1);
 expect(Math.max(...samples.map(s=>s.scroll))-Math.min(...samples.map(s=>s.scroll))).toBeLessThan(2);
 expect(await page.locator('main').evaluate(el=>el.scrollTop)).toBeCloseTo(scroll,0);
 expect((await frame.boundingBox()).width).toBeCloseTo(baseline.width,1);
 // Pull beyond the opposite edge: stop at a usable frame, never collapse it.
 await drag(page,page.getByTestId('art-handle-1'),-700,0);await page.mouse.up();
 await expect(frame.locator('.page-proof')).toBeVisible();
 await expect(page.getByTestId('art-slot-0')).toBeVisible();
 expect((await frame.boundingBox()).height).toBeCloseTo(baseline.height,1);
 await page.screenshot({path:'test-results/frame-resize-stable.png'});
});
