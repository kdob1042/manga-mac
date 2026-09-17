import {test,expect} from '@playwright/test';import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
for(const initialDraft of [false,true])test(initialDraft?'first draft uses source candidate generation before atomic adoption and export':'selected source diff reaches existing AI, explicit adoption and residual Undo',async({page})=>{
 await page.goto('/');
 await page.evaluate(async({legacy,initialDraft})=>{
  const {migrateProject}=await import('/src/revisions.js'),{upgradeSourceProject}=await import('/src/source-application.js');
  const snapshots=[{id:'old',sha:'old',scenes:[{id:'S',text:'A\n\nB\n\nC'}],settings:[]},{id:'new',sha:'new',scenes:[{id:'S',text:'X\n\nB\n\nC\n\nY'}],settings:[]}];
  let p={...legacy,snapshots,active:'new',history:[],jobs:[],panels:[0,1,2].map(i=>({...legacy.panels[0],id:`p${i}`,snapshotId:'old',sceneId:'S',unitIds:[`S:u${i}`],lettering:undefined,characterIds:[]}))};delete p.layout;
  if(initialDraft)p.panels=[];p=await upgradeSourceProject(await migrateProject(p));p.workId='work';p.contentToken='t0';localStorage.setItem('source-fixture',JSON.stringify(p));
 },{legacy,initialDraft});
 await page.addInitScript(()=>{
  let project=JSON.parse(localStorage.getItem('source-fixture')),revision=0;window.sourceCalls=[];
  const content=p=>JSON.stringify([p.panels,p.layout,p.sourceApplication,p.active]);
  function save(next){if(content(next)!==content(project))next.contentToken=`t${++revision}`;else next.contentToken=project.contentToken;next.sourcePatchReceipts={...next.sourcePatchReceipts,...project.sourcePatchReceipts};project=next;localStorage.setItem('source-fixture',JSON.stringify(project));window.sourceSaved=project;}
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   window.sourceCalls.push(command);
   if(command==='load_project')return JSON.stringify(project);
   if(command==='save_project'){save(JSON.parse(args.data));return;}
   if(command==='source_library')return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'test/repo',episode:'P01'}]};
   if(command==='backup_status')return {config:null,status:{},restored:[]};
   if(command==='register_llm')return 'plan-fixture';if(command==='remove_llm')return;
   if(command==='generate_image'){const canvas=document.createElement('canvas');canvas.width=args.request.width;canvas.height=args.request.height;const ctx=canvas.getContext('2d');ctx.fillStyle='#668899';ctx.fillRect(0,0,canvas.width,canvas.height);return canvas.toDataURL();}
   if(command==='llm_request'){
    const r=args.request;if(r.purpose==='probe')return {request_id:r.request_id,value:{ok:true}};
    if(r.purpose!=='plan')throw Error('unexpected generation');const input=JSON.parse(r.prompt);window.sourceInput=input;
    return {request_id:r.request_id,value:{reason:'台詞だけを更新して作画を再利用',panels:[{unitIds:input.mutableUnits.map(u=>u.id),prompt:input.currentPanels[0]?.prompt??'new art',characterIds:[],reusePanelId:input.currentPanels[0]?.id??null}]}};
   }
   if(command==='prepare_source_patch'){
    if(args.baseContentToken!==project.contentToken||args.workId!==project.workId)throw Error('stale');
    const plan={baseContentToken:args.baseContentToken,targetSnapshotId:args.targetSnapshotId,expected:args.expected,scope:{pageIds:project.layout.pages.map(p=>p.id)}};
    save({...project,jobs:[...project.jobs,{id:args.opId,kind:'sourcePatch',status:'planned',source_patch:plan}]});return plan;
   }
   if(command==='commit_source_patch'){
    if(project.sourcePatchReceipts?.[args.opId])return project;
    if(args.baseContentToken!==project.contentToken)throw Error('stale');
    const before={panels:project.panels,layout:project.layout,sourceApplication:project.sourceApplication};
    save({...project,...args.patch,history:[...project.history,{...before,sourcePatch:true,edit:true,after:args.patch,label:'原稿差分を反映'}],editRedo:[],sourcePatchReceipts:{[args.opId]:true},jobs:project.jobs.map(j=>j.id===args.opId?{...j,status:'complete'}:j)});return project;
   }
   throw Error('unexpected '+command);
  }};
 });
 await page.reload();await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'接続をテスト',exact:true}).click();await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await page.getByText('原稿と漫画への反映状態',{exact:true}).click();const source=page.getByRole('region',{name:'原稿',exact:true});await expect(source.getByRole('checkbox')).toHaveCount(initialDraft?1:2);await source.getByRole('checkbox').first().check();
 await source.getByRole('button',{name:'選択箇所を漫画に反映',exact:true}).click();const candidate=page.getByRole('region',{name:'原稿反映の更新案'});await expect(candidate).toBeVisible();

 if(initialDraft){
  await expect(candidate.getByRole('button',{name:'この更新案を適用'})).toBeDisabled();
  await candidate.getByRole('button',{name:'画像AIで不足分を作画・再開'}).click();await expect(candidate.getByRole('button',{name:'この更新案を適用'})).toBeEnabled();
  expect(await page.evaluate(()=>window.sourceSaved.panels.length)).toBe(0);expect(await page.evaluate(()=>window.sourceCalls.filter(c=>c==='generate_image').length)).toBe(1);
  await candidate.getByRole('button',{name:'この更新案を適用'}).click();await expect(source.getByRole('checkbox')).toHaveCount(0);
  const output=await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js'),{exportCBZ}=await import('/src/export.js');const p=await loadProject();return {units:p.sourceApplication.units.length,size:(await exportCBZ(p)).size};});
  expect(output.units).toBe(4);expect(output.size).toBeGreaterThan(100);return;
 }
 expect(await page.evaluate(()=>window.sourceCalls.filter(c=>c==='commit_source_patch').length)).toBe(0);expect(await page.evaluate(()=>window.sourceInput.mutableUnits.map(u=>u.text))).toEqual(['X']);
 const images=await page.evaluate(()=>window.sourceSaved.panels.map(p=>p.image));
 await candidate.getByRole('button',{name:'この更新案を適用'}).click();await expect(source.getByRole('checkbox')).toHaveCount(1);await expect(source.locator('.source-addition')).toContainText('Y');
 expect(await page.evaluate(()=>window.sourceSaved.panels.map(p=>p.image))).toEqual(images);expect(await page.evaluate(()=>window.sourceCalls.filter(c=>c==='generate_image').length)).toBe(0);
 await page.getByRole('button',{name:'↶ 元に戻す',exact:true}).click();await expect(source.getByRole('checkbox')).toHaveCount(2);
 await page.getByRole('button',{name:'↷ やり直す',exact:true}).click();await expect(source.getByRole('checkbox')).toHaveCount(1);
 await page.reload();await page.getByText('原稿と漫画への反映状態',{exact:true}).click();await expect(page.getByRole('region',{name:'原稿',exact:true}).getByRole('checkbox')).toHaveCount(1);
});
