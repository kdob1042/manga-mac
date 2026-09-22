import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import JSZip from 'jszip';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/name-plan-v2-project.json',import.meta.url)));

async function setup(page){
 await page.goto('/');
 const target=await page.evaluate(async p=>{
  const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d');ctx.fillStyle='#dae5d8';ctx.fillRect(0,0,128,128);
  p.panels=p.panels.map(panel=>({...panel,image:canvas.toDataURL(),artwork_revision:null}));
  p.history=[];p.jobs=[];p.artworks=[];
  p.layout.pages[0].slots.forEach((slot,i)=>{const y=i?.5:.05;slot.points=[[.05,y],[.95,y],[.95,y+.3],[.05,y+.3]];});
  const panel=p.panels.find(panel=>panel.requiredText?.length);
  panel.lettering.boxes[0]={...panel.lettering.boxes[0],x:.1,y:.1,width:.8,height:.8,kind:'narration',shape:'rect',tail:null};
  delete panel.lettering.boxes[0].fontSize;
  await (await import('/src/bridge.js')).saveProject(p);return panel.id;
 },fixture);
 await page.reload();await page.getByRole('button',{name:'仕上げ',exact:true}).click();
 await page.getByLabel('仕上げるコマ',{exact:true}).selectOption(target);
 await expect(page.getByLabel('文字サイズ',{exact:true})).toHaveValue('48');
 return target;
}

async function editorMatchesOutput(page,target){
 return page.evaluate(async id=>{
  const p=await (await import('/src/bridge.js')).loadProject(),pg=p.layout.pages[0];
  const {pagePNG}=await import('/src/render.js'),{imageOf}=await import('/src/canvas-image.js'),{letteringFrame}=await import('/src/visual-regions.js');
  const frame=letteringFrame(p,id),im=await imageOf(await pagePNG(p.panels,p.snapshots,p.localizations,p.output_locale,pg,true,p.layout.imageCrops));
  const editor=document.querySelector('.lettering-stage canvas'),expected=document.createElement('canvas');expected.width=editor.width;expected.height=editor.height;
  const ctx=expected.getContext('2d');ctx.drawImage(im,frame.x,frame.y,frame.width,frame.height,0,0,expected.width,expected.height);
  const a=ctx.getImageData(3,3,expected.width-6,expected.height-6).data,b=editor.getContext('2d').getImageData(3,3,editor.width-6,editor.height-6).data;
  let different=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])different++;
  return {different,width:editor.width,height:editor.height,ratio:frame.width/frame.height};
 },target);
}

test('name-v2 actual aspect editor matches PNG before and after vertical font changes, reload and Undo',async({page})=>{
 const target=await setup(page);
 await expect.poll(async()=> (await editorMatchesOutput(page,target)).different).toBe(0);
 const baseline=await page.evaluate(async()=>await (await import('/src/bridge.js')).loadProject());
 const geometry=await editorMatchesOutput(page,target);expect(geometry.width/geometry.height).toBeCloseTo(geometry.ratio);expect(geometry.width).not.toBe(geometry.height);
 await page.getByLabel('文字方向',{exact:true}).selectOption('vertical-rl');await page.getByLabel('書体',{exact:true}).selectOption('mincho');
 await page.getByRole('button',{name:'文字配置を適用',exact:true}).click();
 await expect.poll(async()=>page.evaluate(async()=> (await (await import('/src/bridge.js')).loadProject()).panels.find(p=>p.requiredText?.length).lettering.boxes[0].writingMode)).toBe('vertical-rl');
 await expect.poll(async()=> (await editorMatchesOutput(page,target)).different).toBe(0);
 const after=await page.evaluate(async()=>await (await import('/src/bridge.js')).loadProject());
 expect(after.panels.map(p=>p.image)).toEqual(baseline.panels.map(p=>p.image));expect(after.snapshots).toEqual(baseline.snapshots);expect(after.jobs).toEqual(baseline.jobs);
 await page.reload();await page.getByRole('button',{name:'仕上げ',exact:true}).click();await page.getByLabel('仕上げるコマ',{exact:true}).selectOption(target);
 await expect(page.getByLabel('文字方向',{exact:true})).toHaveValue('vertical-rl');await expect(page.getByLabel('書体',{exact:true})).toHaveValue('mincho');
 await expect.poll(async()=> (await editorMatchesOutput(page,target)).different).toBe(0);
 await page.locator('.lettering-stage').screenshot({path:test.info().outputPath('vertical-editor.png')});
 await page.getByRole('button',{name:'↶ 元に戻す',exact:true}).click();
 await expect(page.getByLabel('文字方向',{exact:true})).toHaveValue('horizontal-tb');
 await expect.poll(async()=> (await editorMatchesOutput(page,target)).different).toBe(0);
});

test('vertical Japanese keeps PNG CBZ and Live identical and redraws bounded text at export density',async({page})=>{
 await setup(page);
 const exports=await page.evaluate(async()=>{
  const p=await (await import('/src/bridge.js')).loadProject();
  p.panels.forEach(panel=>panel.lettering.boxes.forEach(box=>{box.writingMode='vertical-rl';box.fontFamily='mincho';}));
  const {pagePNG,pageLayers}=await import('/src/render.js'),{exportCBZ}=await import('/src/export.js'),{prepareLiveManga}=await import('/src/live-export.js');
  const pg=p.layout.pages[0],png=await pagePNG(p.panels,p.snapshots,p.localizations,p.output_locale,pg,false,p.layout.imageCrops);
  const live=await prepareLiveManga(p,()=>{throw Error('no video expected');});
  const overlay=await pageLayers(p.panels,p.snapshots,p.localizations,p.output_locale,'overlay',pg,false,p.layout.imageCrops);
  const zip=await exportCBZ(p);
  return {png,sameLive:live.sources[live.manifest.pages[0].fallback].image===png,sameOverlay:live.sources[live.manifest.pages[0].overlay].image===overlay,zip:Array.from(new Uint8Array(await zip.arrayBuffer()))};
 });
 expect(exports.sameLive).toBe(true);expect(exports.sameOverlay).toBe(true);
 const zip=await JSZip.loadAsync(exports.zip);expect(await zip.file('001.png').async('base64')).toBe(exports.png.split(',')[1]);
 const result=await page.evaluate(async()=>{
  const {drawLettering}=await import('/src/render.js');
  const c=document.createElement('canvas');c.width=800;c.height=800;const ctx=c.getContext('2d');
  ctx.scale(2,2);await drawLettering(ctx,'「図書室ー。」\nコーヒー、きゃっ！？\n12時 ABC', {x:10,y:10,width:380,height:380},true,{fontSize:28,padding:20,writingMode:'vertical-rl',fontFamily:'gothic',shape:'rect'});
  const data=ctx.getImageData(0,0,800,800).data;
  let ink=0,escaped=0;for(let y=0;y<800;y++)for(let x=0;x<800;x++){const a=data[(y*800+x)*4+3];if(a){ink++;if(x<17||x>783||y<17||y>783)escaped++;}}
  return {ink,escaped,png:c.toDataURL()};
 });
 expect(result.ink).toBeGreaterThan(10000);expect(result.escaped).toBe(0);
 await page.setContent(`<img alt="縦書きの出力確認" src="${result.png}" style="width:800px">`);
 await page.screenshot({path:test.info().outputPath('vertical-glyph-proof.png')});
});
