import {test,expect} from '@playwright/test';
test('one start creates six-panel draft, resumes lettering only, edits third panel and persists undo/redo',async({page})=>{
 await page.addInitScript(()=>{
   let project={version:4,title:'初稿試験',active:'source',snapshots:[{id:'source',sha:'fixture',settings:[],scenes:[{id:'s',text:Array.from({length:6},(_,i)=>`本文${i}。`).join('\n\n')}]}],panels:Array.from({length:6},(_,i)=>({id:`p${i}`,sceneId:'s',snapshotId:'source',unitIds:[`s:u${i}`],characterIds:[],prompt:'Library',image:null,status:'planned',instructions:[],attempts:0})),characters:[],history:[],jobs:[],artworks:[],localizations:[],output_locale:'ja'};
   let lettering=0,failed=false;window.calls=[];
   window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
     window.calls.push({command,args});
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'kdob1042/Kamiya-Kawai',episode:'P01'}]};
     if(command==='load_project')return JSON.stringify(project);
     if(command==='save_project'){project=JSON.parse(args.data);window.saved=project;return;}
     if(command==='backup_status')return {config:null,status:{},restored:[]};
     if(command==='register_llm')return 'fixture-plan';
     if(command==='remove_llm')return;
     if(command==='generate_image'){const c=document.createElement('canvas');c.width=args.request.width;c.height=args.request.height;const ctx=c.getContext('2d');ctx.fillStyle='#c5d7c9';ctx.fillRect(0,0,c.width,c.height);return c.toDataURL();}
     if(command==='llm_request'){
       const r=args.request;let value;if(r.purpose==='probe')value={ok:true};
       else if(r.purpose==='layout'){
         const input=JSON.parse(r.prompt),ids=input.panels.map(p=>p.id);
         value={reason:'6コマ',pages:[{id:input.pages[0].id,slots:ids.map((id,i)=>{const x=i%2===0?.52:.04,y=.03+Math.floor(i/2)*.32,w=.44,h=.30;return {id:`slot${i}`,panelId:id,points:[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]};})}]};
       }else if(r.purpose==='lettering'){
         lettering++;if(lettering===2&&!failed){failed=true;throw Error('文字配置の接続失敗');}
         const input=JSON.parse(r.prompt);value={reason:'本文の配置',layout:input.current?{...input.current,mode:'balloons'}:{mode:'balloons',boxes:input.boxes.map(({text,...box})=>box)}};
       }else if(r.purpose==='edit'){
         const input=JSON.parse(r.prompt),target=input.context.panels[2],layout=structuredClone(target.lettering);layout.boxes[0].x=.1;
         if(input.instruction.includes('解像度'))value={reason:'3コマ目を診断',operations:[{kind:'resolution',panelId:target.id,args:{}}]};
         else if(input.instruction.includes('2倍'))value={reason:'補間拡大候補',operations:[{kind:'upscale',panelId:target.id,args:{factor:2}}]};
         else value={reason:'3コマ目の文字を左へ',operations:[{kind:'lettering',panelId:target.id,args:layout}]};
       }else throw Error('Unexpected purpose '+r.purpose);
       return {request_id:r.request_id,value};
     }
     throw Error('Unexpected '+command);
   }};
 });
 await page.goto('/');await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'接続をテスト',exact:true}).click();await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await page.getByLabel('制作方法',{exact:true}).selectOption('direct');await page.getByRole('button',{name:'✧ 漫画にする',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'文字配置の接続失敗'})).toBeVisible();
 expect(await page.evaluate(()=>window.calls.filter(c=>c.command==='generate_image').length)).toBe(6);
 await page.getByRole('button',{name:'✧ 漫画にする',exact:true}).click();await expect(page.getByRole('img',{name:'書き出しページの確認'})).toBeVisible();
 expect(await page.evaluate(()=>window.calls.filter(c=>c.command==='generate_image').length)).toBe(6);
 const before=await page.evaluate(()=>window.saved);expect(before.panels.every(p=>p.image&&p.lettering)).toBe(true);expect(before.layout.pages[0].slots.length).toBe(6);
 await page.getByLabel('編集の指示',{exact:true}).fill('3コマ目の文字を左へ');await page.getByRole('button',{name:'修正する ↑',exact:true}).click();await page.getByRole('button',{name:'この編集を適用',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.saved.panels[2].lettering.boxes[0].x)).toBe(.1);
 await page.getByRole('button',{name:'↶ 元に戻す',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.saved.panels[2].lettering.boxes[0].x)).toBe(.55);
 await page.getByRole('button',{name:'↷ やり直す',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.saved.panels[2].lettering.boxes[0].x)).toBe(.1);
 const after=await page.evaluate(()=>window.saved);expect(after.panels.map(p=>p.image)).toEqual(before.panels.map(p=>p.image));expect(after.snapshots).toEqual(before.snapshots);
 await page.locator('.panel').nth(2).click();const handle=page.getByTestId('letter-box-0');await handle.scrollIntoViewIfNeeded();const b=await handle.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+20,b.y+b.height/2+15);await page.mouse.up();
 await expect.poll(()=>page.evaluate(()=>window.saved.panels[2].lettering.boxes[0].x)).toBeGreaterThan(.1);
 expect(await page.evaluate(()=>window.calls.filter(c=>c.command==='generate_image').length)).toBe(6);
 await page.screenshot({path:'test-results/initial-draft-editing.png',fullPage:true});
 const exported=await page.evaluate(async()=>{const {exportCBZ}=await import('/src/export.js');return (await exportCBZ(window.saved)).size;});expect(exported).toBeGreaterThan(1000);
 await page.getByLabel('編集の指示',{exact:true}).fill('3コマ目の解像度を確認');await page.getByRole('button',{name:'修正する ↑',exact:true}).click();await page.getByRole('button',{name:'この編集を適用',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'元画像 768×768px／必要'})).toBeVisible();
 await page.getByLabel('編集の指示',{exact:true}).fill('3コマ目を2倍に補間拡大');await page.getByRole('button',{name:'修正する ↑',exact:true}).click();await page.getByRole('button',{name:'この編集を適用',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.saved.jobs.filter(j=>j.kind==='upscale'&&j.status==='candidate').length)).toBe(1);
 expect(await page.evaluate(()=>window.calls.filter(c=>c.command==='generate_image').length)).toBe(6);
 expect(await page.evaluate(()=>window.saved.panels.map(p=>p.image))).toEqual(before.panels.map(p=>p.image));
});
