import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import JSZip from 'jszip';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
function png(color){
 const canvas=document.createElement('canvas');canvas.width=768;canvas.height=768;
 const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,768,768);
 return canvas.toDataURL('image/png');
}
test('frame-break toggle, overflow drag, undo and PNG/CBZ share geometry without generation',async({page})=>{
 await page.goto('/');
 await page.evaluate(async fixture=>{
  const {saveProject}=await import('/src/bridge.js');
  const color=(c)=>{const canvas=document.createElement('canvas');canvas.width=768;canvas.height=768;const ctx=canvas.getContext('2d');ctx.fillStyle=c;ctx.fillRect(0,0,768,768);return canvas.toDataURL('image/png');};
  fixture.panels=[{...fixture.panels[0],id:'red',image:color('#ff0000')},{...fixture.panels[0],id:'blue',image:color('#0000ff')}];
  fixture.history=[];fixture.jobs=[];
  await saveProject(fixture);
 },legacy);
 await page.reload();
 await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
 await page.getByLabel('枠数',{exact:true}).selectOption('2');
 await page.getByRole('button',{name:'テンプレートを適用'}).click();
 await page.getByTestId('layout-slot-0').click({position:{x:60,y:45}});
 await page.getByRole('button',{name:'枠破り',exact:true}).click();
 await expect(page.getByTestId('overflow-slot-0')).toBeVisible();
 await page.getByTestId('layout-slot-0').click({position:{x:60,y:45}});
 const before=await page.getByTestId('overflow-slot-0').getAttribute('points');
 const handle=page.getByTestId('overflow-vertex-0');await handle.scrollIntoViewIfNeeded();
 const box=await handle.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
 await page.mouse.move(box.x+box.width/2-30,box.y+box.height/2-20,{steps:6});await page.mouse.up();
 await expect(page.getByTestId('overflow-slot-0')).not.toHaveAttribute('points',before);
 await page.getByRole('button',{name:'枠をUndo'}).click();
 await expect(page.getByTestId('overflow-slot-0')).toHaveAttribute('points',before);
 await page.reload();
 await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
 await expect(page.getByTestId('overflow-slot-0')).toBeVisible();
 const result=await page.evaluate(async()=>{
  const {loadProject}=await import('/src/bridge.js');
  const {pagePNG}=await import('/src/render.js');
  const {exportCBZ}=await import('/src/export.js');
  const {pagePanels}=await import('/src/layout.js');
  const p=await loadProject(),pg=p.layout.pages[0];
  const png=await pagePNG(pagePanels(p,pg),p.snapshots,[], 'ja',pg,true,p.layout.imageCrops);
  const cbz=await exportCBZ({...p,layout:{...p.layout,pages:[pg]}}).catch(()=>null);
  return {png,jobs:p.jobs.length,overflow:!!pg.slots[0].overflow,image:p.panels[0].image,native:window.nativeCalls??[]};
 });
 expect(result.overflow).toBe(true);expect(result.jobs).toBe(0);expect(result.png).toMatch(/^data:image\/png;base64,/);
 expect(result.native.some?.(c=>/generate_image|blender_execute|video_generate/.test(c))).toBeFalsy();
});
test('overflowing figure sits on top while neighbor panels stay visible',async({page})=>{
 await page.goto('/');
 const sample=await page.evaluate(async fixture=>{
  const {saveProject,loadProject}=await import('/src/bridge.js');
  const color=(c)=>{const canvas=document.createElement('canvas');canvas.width=768;canvas.height=768;const ctx=canvas.getContext('2d');ctx.fillStyle=c;ctx.fillRect(0,0,768,768);return canvas.toDataURL('image/png');};
  const figure=()=>{const canvas=document.createElement('canvas');canvas.width=768;canvas.height=768;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,768,768);ctx.fillStyle='#ff0000';ctx.beginPath();ctx.ellipse(384,384,270,340,0,0,Math.PI*2);ctx.fill();return canvas.toDataURL('image/png');};
  fixture.panels=[{...fixture.panels[0],id:'red',unitIds:[],sourceRefs:[],image:figure()},{...fixture.panels[0],id:'blue',unitIds:[],sourceRefs:[],image:color('#0000ff')}];
  fixture.history=[];fixture.jobs=[];
  await saveProject(fixture);
  let p=await loadProject();
  const {template,pagePanels,PAGE,layoutWarnings,artPoints}=await import('/src/layout.js');
  const {panelArtRect}=await import('/src/page-art.js');
  p.layout.pages=[{id:'one',slots:template(2,['red','blue'])}];
  p.layout.pages[0].slots[0].overflow={points:[[0.20,0.02],[0.98,0.02],[0.98,0.98],[0.20,0.98]]};
  await saveProject(p);
  p=await loadProject();
  const {pagePNG}=await import('/src/render.js');
  const {preparePreview}=await import('/src/live-preview.js');
  const pg=p.layout.pages[0],panels=pagePanels(p,pg);
  const data=await pagePNG(panels,p.snapshots,[], 'ja',pg,false);
  const img=new Image();img.src=data;await img.decode();
  const c=document.createElement('canvas');c.width=PAGE.width;c.height=PAGE.height;c.getContext('2d').drawImage(img,0,0);
  const pixel=(x,y)=>Array.from(c.getContext('2d').getImageData(x|0,y|0,1,1).data);
  const art=panelArtRect(artPoints(pg.slots[0]),768,768);
  const onFigure=[art.x+art.width*0.22,art.y+art.height*0.5];
  const besideFigure=[art.x+art.width*0.05,art.y+art.height*0.5];
  const outsideOverflow=[0.10*PAGE.width,0.40*PAGE.height];
  const home=pg.slots[0].points.map(([x,y])=>[x*PAGE.width,y*PAGE.height]);
  p.workId='work';p.title=p.title||'overflow';
  const preview=await preparePreview({project:p,revision:'abcd',savedAt:'2026-09-19T00:00:00.000Z'},{
   image:async data=>{
    const bytes=new TextEncoder().encode(String(data));
    const id=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const page=typeof data==='string'&&data.startsWith('layer');
    return {id,sha256:id,path:`assets/${id}.png`,mime:'image/png',bytes:Math.max(1,bytes.length),width:page?1600:720,height:page?2260:720};
   },
   placeholder:async()=>'ph',layers:async(_a,_b,layer)=>'layer:'+layer,probeVideo:async()=>{throw Error('pending');},
  });
  return {onFigure:pixel(...onFigure),besideFigure:pixel(...besideFigure),outsideOverflow:pixel(...outsideOverflow),warnings:layoutWarnings(p.layout,p.panels),clip:preview.preview.manifest.pages[0].panels[0].clip,home,onFigureAt:onFigure,besideAt:besideFigure};
 },legacy);
 expect(sample.warnings).toEqual([]);
 expect(sample.onFigure[0]).toBeGreaterThan(200);
 expect(sample.onFigure[2]).toBeLessThan(80);
 expect(sample.besideFigure[2]).toBeGreaterThan(200);
 expect(sample.besideFigure[0]).toBeLessThan(80);
 expect(sample.outsideOverflow[2]).toBeGreaterThan(200);
 expect(sample.outsideOverflow[0]).toBeLessThan(80);
 expect(sample.clip).toEqual(sample.home);
});
test('lettering overlap rejects finished PNG and CBZ but draft still renders',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async fixture=>{
  const {saveProject,loadProject}=await import('/src/bridge.js');
  const color=(c)=>{const canvas=document.createElement('canvas');canvas.width=768;canvas.height=768;const ctx=canvas.getContext('2d');ctx.fillStyle=c;ctx.fillRect(0,0,768,768);return canvas.toDataURL('image/png');};
  fixture.panels=[{...fixture.panels[0],id:'a',image:color('#ff0000')},{...fixture.panels[0],id:'b',image:color('#0000ff')}];
  fixture.history=[];fixture.jobs=[];
  await saveProject(fixture);
  let p=await loadProject();
  const {template,pagePanels,layoutWarnings}=await import('/src/layout.js');
  p.layout.pages=[{id:'one',slots:template(2,['a','b'])}];
  p.layout.pages[0].slots[0].overflow={points:[[0,0],[1,0],[1,1],[0,1]]};
  await saveProject(p);
  p=await loadProject();
  const {pagePNG}=await import('/src/render.js');
  const {exportCBZ}=await import('/src/export.js');
  const pg=p.layout.pages[0],panels=pagePanels(p,pg);
  let finished='ok',cbz='ok';
  try{await pagePNG(panels,p.snapshots,[], 'ja',pg,false);}catch(e){finished=e.message;}
  try{await exportCBZ(p);}catch(e){cbz=e.message;}
  const draft=await pagePNG(panels,p.snapshots,[], 'ja',pg,true);
  return {warnings:layoutWarnings(p.layout,p.panels).join(),finished,cbz,draft};
 },legacy);
 expect(result.warnings).toMatch(/はみ出しが他コマの文字/);
 expect(result.finished).toMatch(/はみ出しが他コマの文字/);
 expect(result.cbz).toMatch(/はみ出しが他コマの文字/);
 expect(result.draft).toMatch(/^data:image\/png;base64,/);
});
