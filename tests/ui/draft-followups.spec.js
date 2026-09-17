import {test,expect} from '@playwright/test';
async function setup(page) {
 await page.addInitScript(()=>{
  const canvas=document.createElement('canvas');canvas.width=768;canvas.height=768;const ctx=canvas.getContext('2d');ctx.fillStyle='#55aa55';ctx.fillRect(0,0,768,768);const image=canvas.toDataURL();
  let project=JSON.parse(localStorage.getItem('fixture-project')||'null')??{version:4,title:'引継ぎ試験',active:'source',snapshots:[{id:'source',sha:'fixture',settings:[],scenes:[{id:'a',text:'旧稿の本文。'},{id:'b',text:'次の場面。'}]}],panels:[{id:'old-panel',sceneId:'a',snapshotId:'source',unitIds:['a:u0'],characterIds:[],prompt:'Library',image,status:'review',instructions:[],attempts:0}],characters:[],history:[],jobs:[],artworks:[],localizations:[],output_locale:'ja'};
  window.calls=[];window.saved=project;
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   window.calls.push({command,args});
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'example/story',episode:'P01'}]};
   if(command==='load_project')return JSON.stringify({...project,workId:'fixture-work',contentToken:project.contentToken??'fixture-token'});
   if(command==='save_project'){project=JSON.parse(args.data);window.saved=project;localStorage.setItem('fixture-project',args.data);return;}
   if(command==='prepare_source_patch'){const plan={expected:args.expected,baseContentToken:args.baseContentToken,targetSnapshotId:args.targetSnapshotId,scope:{pageIds:project.layout.pages.map(p=>p.id)}};project.jobs.push({id:args.opId,kind:'sourcePatch',status:'planned',source_patch:plan});return plan;}
   if(command==='commit_source_patch'){const before={panels:project.panels,layout:project.layout,sourceApplication:project.sourceApplication};project={...project,...args.patch,workId:'fixture-work',contentToken:'applied-token',history:[...project.history,{...before,sourcePatch:true,edit:true,after:args.patch}],sourcePatchReceipts:{[args.opId]:true}};project.jobs=project.jobs.map(j=>j.id===args.opId?{...j,status:'complete'}:j);window.saved=project;window.savedProject=project;return project;}
   if(command==='backup_status')return {config:null,status:{},restored:[]};
   if(command==='register_llm')return 'plan-fixture';
   if(command==='remove_llm')return;
   if(command==='generate_image'){ctx.fillStyle='#3355cc';ctx.fillRect(0,0,768,768);return canvas.toDataURL();}
   if(command==='llm_request') {
    const r=args.request;let value;
    if(r.purpose==='probe')value={ok:true};
    else if(r.purpose==='plan')value={panels:[{unitIds:['b:u0'],prompt:'次の場面',characterIds:[]}]};
    else if(r.purpose==='layout'){const input=JSON.parse(r.prompt);value={reason:'配置',pages:input.pages};}
    else if(r.purpose==='lettering')value={reason:'本文',layout:JSON.parse(r.prompt).current};
    else if(r.purpose==='vision'){const input=JSON.parse(r.prompt);value={uncertain:false,reason:'服',regions:[{panelId:input.panels[0].id,purpose:'edit',label:'服の候補',rect:[.2,.3,.3,.4]}]};}
    else if(r.purpose==='edit'){const input=JSON.parse(r.prompt),p=input.context.panels[0];value={reason:'対象を編集',operations:[input.instruction.includes('服')?{kind:'region',panelId:p.id,args:{instruction:'服を青く'}}:{kind:'crop',panelId:p.id,args:{x:.4,y:.5,zoom:1.2}}]};}
    else throw Error('Unexpected purpose '+r.purpose);
    return {request_id:r.request_id,value};
   }
   throw Error('Unexpected command '+command);
  }};
 });
 await page.goto('/');
}
async function connect(page,vision=false){await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'接続をテスト',exact:true}).click();if(vision)await page.getByLabel('対象認識・文字配置に作画画像をこの接続へ送る').check();await page.getByRole('button',{name:'閉じる',exact:true}).click();}

test('selected-scene draft retains old manuscript; saved edit comparison survives restart without connection',async({page})=>{
 await setup(page);await connect(page);await page.getByLabel('制作方法',{exact:true}).selectOption('direct');
 await page.getByText('制作する場面・保存した原稿',{exact:true}).click();await page.getByRole('group',{name:'制作する場面',exact:true}).getByLabel('a',{exact:true}).uncheck();await page.getByLabel('既存原稿を残して別の初稿を作る').check();
 await page.getByRole('button',{name:'✧ 漫画にする',exact:true}).click();await expect(page.getByRole('img',{name:'書き出しページの確認'})).toBeVisible();
 expect(await page.evaluate(()=>window.saved.panels.map(p=>p.sceneId))).toEqual(['b']);expect(await page.evaluate(()=>window.calls.filter(c=>c.command==='generate_image').length)).toBe(1);
 await page.getByLabel('編集の指示',{exact:true}).fill('1コマ目の画像を右へ');await page.getByRole('button',{name:'修正する ↑',exact:true}).click();await expect(page.getByRole('button',{name:'この編集を適用',exact:true})).toBeVisible();
 await page.reload();await page.getByText(/保存した編集候補（1件）/).click();await page.getByRole('button',{name:'変更前後を比較',exact:true}).click();await expect(page.getByRole('img',{name:'編集候補のページ',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'候補を開く',exact:true}).click();await page.getByRole('button',{name:'この編集を適用',exact:true}).click();await expect.poll(()=>page.evaluate(()=>Object.values(window.saved.layout.imageCrops??{})[0]?.zoom)).toBe(1.2);
 expect(await page.evaluate(()=>window.calls.filter(c=>c.command==='llm_request').length)).toBe(0);
 await page.getByText('制作する場面・保存した原稿',{exact:true}).click();const id=await page.evaluate(()=>window.saved.history.find(h=>h.draftCheckpoint).id);await page.getByLabel('保存した原稿',{exact:true}).selectOption(id);
 await expect.poll(()=>page.evaluate(()=>window.saved.panels[0].id)).toBe('old-panel');expect(await page.evaluate(()=>window.saved.history.filter(h=>h.draftCheckpoint).at(-1).panels[0].sceneId)).toBe('b');
 await page.screenshot({path:'test-results/draft-checkpoints.png',fullPage:true});
});
test('visual region is proposed only with image opt-in and generated candidate preserves pixels outside rectangle',async({page})=>{
 await setup(page);await connect(page,true);await page.getByLabel('編集の指示',{exact:true}).fill('1コマ目の服を青くして');await page.getByRole('button',{name:'修正する ↑',exact:true}).click();
 await expect(page.getByRole('img',{name:'対象認識の元画像'})).toBeVisible();expect(await page.evaluate(()=>window.calls.filter(c=>c.command==='generate_image').length)).toBe(0);
 await page.getByRole('button',{name:'この編集を適用',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.saved.jobs.filter(j=>j.kind==='edit'&&j.status==='candidate').length)).toBe(1);
 const pixels=await page.evaluate(async()=>{const job=window.saved.jobs.find(j=>j.kind==='edit'&&j.status==='candidate'),art=window.saved.artworks.find(a=>a.id===job.output_revision);const im=new Image();im.src=art.panel.image;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const ctx=c.getContext('2d');ctx.drawImage(im,0,0);return {outside:Array.from(ctx.getImageData(5,5,1,1).data),inside:Array.from(ctx.getImageData(250,300,1,1).data)};});
 expect(pixels.outside).toEqual([85,170,85,255]);expect(pixels.inside).toEqual([51,85,204,255]);
 await page.screenshot({path:'test-results/visual-region-candidate.png',fullPage:true});
});
