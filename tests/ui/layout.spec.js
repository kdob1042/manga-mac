import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import JSZip from 'jszip';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('four corners, cancel, undo/redo and six-panel persistence keep artwork and export geometry',async({page})=>{
 await page.goto('/');
 await page.evaluate(async fixture=>{
   const {saveProject}=await import('/src/bridge.js');
   fixture.panels=Array.from({length:6},(_,i)=>({...fixture.panels[0],id:`panel${i}`}));fixture.history=[];fixture.jobs=[];
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
 await page.locator('.thumbnail').nth(1).click();await page.getByRole('button',{name:'このページを外す'}).click();
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
 await expect(page.locator('.thumbnail')).toHaveCount(1);await page.getByRole('button',{name:'ページ追加'}).click();await expect(page.locator('.thumbnail')).toHaveCount(2);
 await page.locator('.thumbnail').nth(1).click();await page.getByRole('button',{name:'このページを外す'}).click();await expect(page.locator('.thumbnail')).toHaveCount(1);
 const result=await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js');const {pagePNG}=await import('/src/render.js');const {exportCBZ}=await import('/src/export.js');const {pagePanels}=await import('/src/layout.js');const p=await loadProject(),pg=p.layout.pages[0];return {cbz:Array.from(new Uint8Array(await (await exportCBZ(p)).arrayBuffer())),png:await pagePNG(pagePanels(p,pg),p.snapshots,[], 'ja',pg),image:p.panels[0].image,jobs:p.jobs.length,slots:pg.slots.length};});
 expect(result.image).toBe(legacy.panels[0].image);expect(result.jobs).toBe(0);expect(result.slots).toBe(6);expect(result.png).toMatch(/^data:image\/png;base64,/);
 const zip=await JSZip.loadAsync(result.cbz);expect(await zip.file('001.png').async('base64')).toBe(result.png.split(',')[1]);writeFileSync('test-results/free-layout-six-output.png',Buffer.from(result.png.split(',')[1],'base64'));
 await page.screenshot({path:'test-results/free-layout-six.png',fullPage:true});
});

test('AI layout uses registered router and explicit adoption without regenerating art',async({page})=>{
 await page.addInitScript(fixture=>{
   let project={...fixture,jobs:[],history:[]};window.nativeCalls=[];
   window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      if (command === 'acceptance_context') return null;
     window.nativeCalls.push(command);
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'example/story',episode:'P01'}]};
     if(command==='load_project')return JSON.stringify(project);
     if(command==='save_project'){project=JSON.parse(args.data);window.savedProject=project;return;}
     if(command==='backup_status')return {config:null,status:{},restored:[]};
     if(command==='register_llm')return 'layout-planner';
     if(command==='remove_llm')return;
     if(command==='llm_request'){
       const r=args.request;if(r.purpose==='probe')return {request_id:r.request_id,value:{ok:true}};
       if(r.purpose!=='layout'||r.connection_id!=='layout-planner')throw Error('Incorrect layout routing');
       const input=JSON.parse(r.prompt),pages=structuredClone(input.pages);pages[0].slots[0].points[0][0]+=.03;
       return {request_id:r.request_id,value:{reason:'最初のコマの上辺を斜めに',pages}};
     }
     throw Error('Unexpected command '+command);
   }};
 },legacy);
 await page.goto('/');await page.getByRole('button',{name:'接続・人物設定',exact:true}).click();await page.getByRole('button',{name:'接続をテスト',exact:true}).click();await expect(page.getByText('接続を登録済み（この起動中のみ）')).toBeVisible();await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();const initial=await page.getByTestId('layout-slot-0').getAttribute('points');
 await page.getByText('演出AIでこのページを配置',{exact:true}).click();await page.getByLabel('コマ割りの指示',{exact:true}).fill('最初のコマを斜めに');await page.getByRole('button',{name:'コマ割りを提案',exact:true}).click();
 await expect(page.getByRole('button',{name:'採用して編集',exact:true})).toBeEnabled();
 await expect(page.getByRole('button',{name:'採用せず編集',exact:true})).toBeEnabled();
 await expect(page.locator('.layout-candidate button')).toHaveCount(2);
 const proposed=await page.getByTestId('layout-slot-0').getAttribute('points');expect(proposed).not.toBe(initial);
 await expect(page.getByRole('img',{name:'AIコマ割り候補（未採用）'})).toBeVisible();
 await expect(page.locator('.composer')).toBeHidden();
 const pending=await page.evaluate(()=>window.savedProject);
 expect(pending.jobs.at(-1).status).toBe('candidate');
 expect(pending.layout.pages[0].slots[0].points.map(([x,y])=>`${x*1600},${y*2260}`).join(' ')).toBe(initial);
 await page.setViewportSize({width:1440,height:2000});
 await page.screenshot({path:'test-results/free-layout-ai-candidate.png',fullPage:true});
 await page.getByRole('button',{name:'採用して編集',exact:true}).click();await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points',proposed);
 await expect(page.locator('.composer')).toBeVisible();
 await page.getByTestId('layout-slot-0').click({position:{x:60,y:45}});
 const vertex=page.getByTestId('vertex-0');await expect(vertex).toBeVisible();
 const handle=await vertex.boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2+8,handle.y+handle.height/2+8,{steps:5});await page.mouse.up();
 await expect(page.getByTestId('layout-slot-0')).not.toHaveAttribute('points',proposed);
 const saved=await page.evaluate(()=>window.savedProject);expect(saved.panels[0].image).toBe(legacy.panels[0].image);expect(saved.jobs.at(-1).status).toBe('complete');
 expect((await page.evaluate(()=>window.nativeCalls)).some(c=>/generate_image|blender_execute|video_generate/.test(c))).toBe(false);
 await page.screenshot({path:'test-results/free-layout-ai.png',fullPage:true});
});


test('middle two pages reflow locally, survive reload and Undo, and use no generation',async({page})=>{
 await page.goto('/');await page.evaluate(async fixture=>{const {saveProject}=await import('/src/bridge.js');fixture.panels=Array.from({length:16},(_,i)=>({...fixture.panels[0],id:`panel${i}`}));fixture.history=[];fixture.jobs=[];await saveProject(fixture);},legacy);
 await page.reload();const original=await page.evaluate(async()=>JSON.parse(JSON.stringify(await (await import('/src/bridge.js')).loadProject())));
 await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();await page.locator('.thumbnail').nth(1).click();await page.getByLabel('対象ページ数',{exact:true}).fill('2');await page.getByLabel('枠数',{exact:true}).selectOption('3');await page.getByRole('button',{name:'テンプレートを適用'}).click();await expect(page.locator('.thumbnail')).toHaveCount(5);
 await page.reload();const next=await page.evaluate(async()=>JSON.parse(JSON.stringify(await (await import('/src/bridge.js')).loadProject())));expect(next.layout.pages[0]).toEqual(original.layout.pages[0]);expect(next.layout.pages[4]).toEqual(original.layout.pages[3]);expect(next.panels).toEqual(original.panels);expect(next.jobs).toEqual([]);
 await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();await page.getByRole('button',{name:'枠をUndo'}).click();await expect(page.locator('.thumbnail')).toHaveCount(4);await page.getByRole('button',{name:'枠をRedo'}).click();await expect(page.locator('.thumbnail')).toHaveCount(5);
});
