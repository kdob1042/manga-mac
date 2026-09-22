import {test,expect} from '@playwright/test';import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
for(const stopA of [false,true,'fail'])test(stopA==='fail'?'A planning failure leaves independent B adopted and C unchanged':stopA?'stopping A retains its late candidate while independent B completes':'B can be added during A, finish and adopt first; A adopts without re-planning',async({page})=>{
 await page.goto('/');await page.evaluate(async legacy=>{
  const {migrateProject}=await import('/src/revisions.js'),{upgradeSourceProject}=await import('/src/source-application.js');
  const snapshots=[{id:'old',sha:'old',scenes:Array.from({length:9},(_,i)=>({id:`S${i}`,text:`old${i}`})),settings:[]},{id:'new',sha:'new',scenes:Array.from({length:9},(_,i)=>({id:`S${i}`,text:[0,8].includes(i)?`new${i}`:`old${i}`})),settings:[]}];
  let p={...legacy,snapshots,active:'new',characters:[],history:[],jobs:[],panels:Array.from({length:9},(_,i)=>({...legacy.panels[0],id:`p${i}`,snapshotId:'old',sceneId:`S${i}`,unitIds:[`S${i}:u0`],lettering:undefined,characterIds:[]}))};delete p.layout;p=await upgradeSourceProject(await migrateProject(p));const slot=p.layout.pages[0].slots[0];p.layout.pages=p.panels.map((panel,i)=>({id:`page${i}`,slots:[{...slot,id:`slot${i}`,panelId:panel.id}]}));p.workId='work';p.contentToken='t0';localStorage.setItem('parallel-fixture',JSON.stringify(p));
 },legacy);
 await page.addInitScript(()=>{
  let p=JSON.parse(localStorage.getItem('parallel-fixture')),revision=0;window.parallelCalls=[];window.planGates={};window.initialMiddle=JSON.stringify(p.panels.slice(1,8));
  const content=p=>JSON.stringify([p.panels,p.layout,p.sourceApplication,p.active]);const save=next=>{next.contentToken=content(next)===content(p)?p.contentToken:`t${++revision}`;p=next;window.parallelSaved=p;localStorage.setItem('parallel-fixture',JSON.stringify(p));};
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      if (command === 'acceptance_context') return null;
   window.parallelCalls.push(command);
   if(command==='load_project')return JSON.stringify(p);if(command==='save_project'){save(JSON.parse(args.data));return;}
   if(command==='source_library')return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'test/repo',episode:'P01'}]};if(command==='backup_status')return {config:null,status:{},restored:[]};if(command==='register_llm')return 'external';if(command==='remove_llm')return;
   if(command==='llm_request'){const r=args.request;if(r.purpose==='probe')return {request_id:r.request_id,value:{ok:true}};const input=JSON.parse(r.prompt),name=input.mutableUnits[0].text;await new Promise(resolve=>window.planGates[name]=resolve);if(window.failA&&name==='new0')throw Error('fixture planning failure');return {request_id:r.request_id,value:{reason:`更新 ${name}`,panels:[{unitIds:input.mutableUnits.map(u=>u.id),prompt:input.currentPanels[0].prompt,characterIds:[],reusePanelId:input.currentPanels[0].id}]}};}
   if(command==='prepare_source_patch'){if(args.baseContentToken!==p.contentToken)throw Error('stale');const scope=(await import('/src/source-application.js')).buildAffectedScope(p,args.expected.sourceEdits),index=Number(scope.contentPanelIds[0].slice(1));const plan={baseContentToken:p.contentToken,targetSnapshotId:p.active,expected:args.expected,scope:{panelIds:scope.contentPanelIds,pageIds:index===0?['page0','page1']:['page7','page8']}};save({...p,jobs:[...p.jobs,{id:args.opId,kind:'sourcePatch',status:'planned',source_patch:plan}]});return plan;}
   if(command==='rebase_source_patch'){const j=p.jobs.find(j=>j.id===args.opId);j.source_patch={...j.source_patch,baseContentToken:p.contentToken,expected:args.expected};return j.source_patch;}
   if(command==='commit_source_patch'){if(p.sourcePatchReceipts?.[args.opId])return p;if(args.baseContentToken!==p.contentToken)throw Error('stale');const before={panels:p.panels,layout:p.layout,sourceApplication:p.sourceApplication};save({...p,...args.patch,history:[...p.history,{...before,sourcePatch:true,edit:true,after:args.patch,label:'原稿差分を反映'}],editRedo:[],sourcePatchReceipts:{...p.sourcePatchReceipts,[args.opId]:true},jobs:p.jobs.map(j=>j.id===args.opId?{...j,status:'complete'}:j)});return p;}
   throw Error('unexpected '+command);
  }};
 });
 await page.reload();await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('combobox',{name:'演出・コマ計画の接続先'}).selectOption('openai');await page.getByRole('button',{name:'接続をテスト',exact:true}).click();await page.getByRole('button',{name:'閉じる',exact:true}).click();await page.getByRole('button',{name:'原稿',exact:true}).click();
 const source=page.getByRole('region',{name:'原稿',exact:true}),candidates=page.getByRole('region',{name:'原稿反映の更新案'});
 await source.getByRole('checkbox').first().check();await source.getByRole('button',{name:'選択箇所を漫画に反映',exact:true}).click();await expect.poll(()=>page.evaluate(()=>Object.keys(window.planGates))).toEqual(['new0']);
 await source.getByRole('checkbox').last().check();await source.getByRole('button',{name:'選択箇所を漫画に反映',exact:true}).click();await expect.poll(()=>page.evaluate(()=>Object.keys(window.planGates))).toEqual(['new0','new8']);
 if(stopA===true)await candidates.first().getByRole('button',{name:'この範囲を停止'}).click();
 await page.evaluate(()=>window.planGates.new8());await expect(candidates.last()).toContainText('更新案を確認できます');await candidates.last().getByRole('button',{name:'この更新案を適用'}).click();await expect(candidates).toHaveCount(1);await expect(source.getByRole('checkbox')).toHaveCount(1);
 if(stopA==='fail')await page.evaluate(()=>window.failA=true);
 await page.evaluate(()=>window.planGates.new0());await expect(candidates).toContainText(stopA==='fail'?'失敗・候補を保持':stopA?'停止済み・素材を保持':'更新案を確認できます');
 if(stopA){expect(await page.evaluate(()=>window.parallelSaved.panels[0].id)).toBe('p0');expect(await page.evaluate(()=>window.parallelSaved.jobs.filter(j=>j.status==='candidate').length)).toBe(stopA==='fail'?0:1);}else{await candidates.getByRole('button',{name:'この更新案を適用'}).click();await expect(source.getByRole('checkbox')).toHaveCount(0);}
 expect(await page.evaluate(()=>JSON.stringify(window.parallelSaved.panels.slice(1,8))===window.initialMiddle)).toBe(true);expect(await page.evaluate(()=>window.parallelCalls.filter(c=>c==='llm_request').length)).toBe(3);expect(await page.evaluate(()=>window.parallelCalls.filter(c=>['generate_image','blender_capture','video_generate'].includes(c)).length)).toBe(0);
});
