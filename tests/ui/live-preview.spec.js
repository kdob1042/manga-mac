import {test,expect} from '@playwright/test';
test('real renderer emits fixed incomplete preview with valid PNGs without model calls',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {prepareBrowserPreview}=await import('/src/LivePreviewControls.jsx');
  const {initialLayout}=await import('/src/layout.js');
  const {previewMatches}=await import('/vendor/live-manga/contracts/preview.mjs');
  const canvas=document.createElement('canvas');canvas.width=720;canvas.height=720;const ctx=canvas.getContext('2d');ctx.fillStyle='#3973b9';ctx.fillRect(0,0,720,720);
  const project={workId:'artificial',revision:5,title:'人工途中稿',active:'s',snapshots:[{id:'s',episodeId:'one',scenes:[{id:'rain',text:'雨。',tags:['雨']},{id:'library',text:'図書館。',tags:['図書館']}]}],panels:[{id:'p1',image:null,sourceRefs:[{snapshotId:'s',sceneId:'rain',startCp:0,endCp:2}]},{id:'p2',image:canvas.toDataURL('image/png'),sourceRefs:[]},{id:'p3',image:null,sourceRefs:[{snapshotId:'s',sceneId:'library',startCp:0,endCp:4}]}],artworks:[],videoRevisions:[],jobs:[],videoShots:[],localizations:[],output_locale:'ja',secret:'CANARY'};
  project.layout=initialLayout(project.panels);const pg=project.layout.pages[0];project.layout.pages=[{...pg,slots:pg.slots.slice(0,2)},{id:'second-page',slots:pg.slots.slice(2)}];
  const before=JSON.stringify(project),captured={project,revision:crypto.randomUUID(),savedAt:'2026-09-17T00:00:00.000Z'};
  const prepared=await prepareBrowserPreview(captured);
  const dimensions=await Promise.all(prepared.preview.manifest.assets.map(async asset=>{const image=new Image();image.src=prepared.sources[asset.id].image;await image.decode();return [image.width,image.height,asset.width,asset.height];}));
  return {unchanged:before===JSON.stringify(project),canary:JSON.stringify(prepared).includes('CANARY'),dimensions,panels:prepared.preview.panels,all:previewMatches(prepared.preview).pageIds,rain:previewMatches(prepared.preview,['雨']).pageIds,library:previewMatches(prepared.preview,['図書館']).pageIds};
 });
 expect(result.unchanged).toBe(true);expect(result.canary).toBe(false);
 expect(result.all).toHaveLength(2);expect(result.rain).toHaveLength(1);expect(result.library).toEqual(['second-page']);
 expect(result.panels.map(p=>p.lettering)).toEqual(['pending','none','pending']);
 for(const [w,h,expectedW,expectedH] of result.dimensions)expect([w,h]).toEqual([expectedW,expectedH]);
});
test('changing an approved destination clears its in-memory credential',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const {default:React}=await import('/node_modules/.vite/deps/react.js'),{default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {default:View}=await import('/src/LivePreviewControls.jsx');
  const holder=document.createElement('div');holder.id='preview-controls-test';document.body.prepend(holder);
  const current={current:{workId:'work',title:'人工作品',snapshots:[],panels:[],layout:{pages:[]}}};
  ReactDOM.createRoot(holder).render(React.createElement(View,{current,writer:{},ready:false}));
 });
 const view=page.locator('#preview-controls-test');await view.locator('summary').click();
 await view.getByLabel('承認するWorker origin').fill('https://first.example');
 await view.getByLabel('転送用キー',{exact:true}).fill('w'.repeat(43));
 await view.getByLabel('承認するWorker origin').fill('https://second.example');
 await expect(view.getByLabel('転送用キー',{exact:true})).toHaveValue('');
});
test('late restoration cannot replace a newly typed destination or transfer key',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const {default:React}=await import('/node_modules/.vite/deps/react.js'),{default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {default:View}=await import('/src/LivePreviewControls.jsx');
  window.__TAURI_INTERNALS__={invoke:async command=>{if(command==='live_preview_list')return new Promise(resolve=>{window.finishPreviewLoad=resolve;});throw Error('Unexpected command '+command);}};
  const holder=document.createElement('div');holder.id='preview-race-test';document.body.prepend(holder);
  const current={current:{workId:'work',title:'人工作品',snapshots:[],panels:[],layout:{pages:[]}}};
  ReactDOM.createRoot(holder).render(React.createElement(View,{current,writer:{},ready:true}));
 });
 const view=page.locator('#preview-race-test');await view.locator('summary').click();
 await expect.poll(()=>page.evaluate(()=>typeof window.finishPreviewLoad)).toBe('function');
 await view.getByLabel('承認するWorker origin').fill('https://new.example');
 await view.getByLabel('転送用キー',{exact:true}).fill('n'.repeat(43));
 await page.evaluate(()=>window.finishPreviewLoad([{revision:'old',savedAt:'2026-09-17T00:00:00.000Z',destination:{origin:'https://old.example',baseRevision:null},received:null}]));
 await expect(view.getByLabel('保存した転送記録')).toBeVisible();
 await expect(view.getByLabel('承認するWorker origin')).toHaveValue('https://new.example');
 await expect(view.getByLabel('転送用キー',{exact:true})).toHaveValue('n'.repeat(43));
 await view.getByLabel('保存した転送記録').selectOption('old');
 await expect(view.getByLabel('承認するWorker origin')).toHaveValue('https://old.example');
 await expect(view.getByLabel('転送用キー',{exact:true})).toHaveValue('');
});
