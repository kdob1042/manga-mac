import {test,expect} from '@playwright/test';
test('only manual GitHub checks run; preview is ephemeral and adoption/failure preserve work',async({page})=>{
 await page.clock.install();
 await page.addInitScript(()=>{
  const repo='owner/a',sha='a'.repeat(40),nextSha='b'.repeat(40);
  const manifest={schema_version:4,work:'A',episodes:[{id:'P01',scene_ids:['S1']}],scenes:[{id:'S1',path:'scene.md'}],settings:[{id:'VISUAL',path:'visual.md'}]};
  const visual='![Aのキャラクター基準画](assets/illustrations/a.png)';
  const snapshot={id:`${repo}@${sha}:P01`,repo,sha,episodeId:'P01',manifest,scenes:[{id:'S1',path:'scene.md',text:'旧文',design:''}],settings:[{id:'VISUAL',path:'visual.md',text:visual}],references:[],contract:{aligned_source_commit:'',manifest_schema_version:4}};
  const initial={version:4,title:'A',snapshots:[snapshot],active:snapshot.id,panels:[],artworks:[],characters:[],history:[],jobs:[],localizations:[],output_locale:'ja',videoShots:[],videoRevisions:[],videoHistory:[]};
  window.checks=0;window.failSync=false;window.failSave=false;
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if(command==='source_library')return {active:'primary',entries:[{id:'primary',name:'A',repo,episode:'P01'}]};
   if(command==='source_register')return {entries:[args],id:'primary'};
   if(command==='load_project')return localStorage.getItem('saved')||JSON.stringify(initial);
   if(command==='save_project'){if(window.failSave)throw Error('保存失敗');localStorage.setItem('saved',args.data);return;}
   if(command==='backup_status')return {config:null,status:{last_success:0},restored:[],active:'primary'};
   if(command==='github_get'){window.checks++;if(window.failSync)throw Error('GitHub取得失敗');return JSON.stringify({sha:nextSha});}
   if(command==='github_file'){if(args.sha!==nextSha||args.repo!==repo)throw Error('Wrong source');return args.path==='manifest.json'?JSON.stringify(manifest):args.path==='visual.md'?visual:'新文';}
   if(command==='github_asset')return {image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',hash:'b'.repeat(64)};
   throw Error('Unexpected '+command);
  }};
 });
 await page.goto('/');await expect(page.getByRole('button',{name:'接続・人物設定'})).toBeEnabled();
 await page.clock.fastForward(6*60*1000);expect(await page.evaluate(()=>window.checks)).toBe(0);
 await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
 await expect(page.getByRole('region',{name:'原稿の取込差分'})).toContainText('変更: S1');
 expect(await page.evaluate(()=>window.checks)).toBe(1);expect(await page.evaluate(()=>localStorage.getItem('saved'))).toBeNull();
 await page.reload();await expect(page.getByRole('region',{name:'原稿の取込差分'})).toHaveCount(0);
 await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
 await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'取り込む',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('保存失敗');expect(await page.evaluate(()=>localStorage.getItem('saved'))).toBeNull();
 await page.evaluate(()=>window.failSave=false);await page.getByRole('button',{name:'取り込む',exact:true}).click();
 await expect(page.getByRole('region',{name:'原稿の取込差分'})).toHaveCount(0);
 const saved=await page.evaluate(()=>localStorage.getItem('saved'));expect(JSON.parse(saved).active).toContain('bbbbbbbb');
 await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();await expect(page.getByRole('status').filter({hasText:'更新なし'})).toBeVisible();
 expect(await page.evaluate(()=>localStorage.getItem('saved'))).toBe(saved);
 await page.evaluate(()=>window.failSync=true);await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
 await expect(page.getByRole('status').filter({hasText:'確認失敗'})).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('saved'))).toBe(saved);
});
