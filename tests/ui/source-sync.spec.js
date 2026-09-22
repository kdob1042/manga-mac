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
      if (command === 'acceptance_context') return null;
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
 const baseline=await page.evaluate(()=>localStorage.getItem('saved'));expect(JSON.parse(baseline).version).toBe(5);
 await page.clock.fastForward(6*60*1000);expect(await page.evaluate(()=>window.checks)).toBe(0);
 await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
 await expect(page.getByRole('region',{name:'原稿の取込差分'})).toContainText('変更: S1');
 expect(await page.evaluate(()=>window.checks)).toBe(1);expect(await page.evaluate(()=>localStorage.getItem('saved'))).toBe(baseline);
 await page.reload();await expect(page.getByRole('region',{name:'原稿の取込差分'})).toHaveCount(0);
 await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
 await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'取り込む',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('保存失敗');expect(await page.evaluate(()=>localStorage.getItem('saved'))).toBe(baseline);
 await page.evaluate(()=>window.failSave=false);await page.getByRole('button',{name:'取り込む',exact:true}).click();
 await expect(page.getByRole('region',{name:'原稿の取込差分'})).toHaveCount(0);
 const saved=await page.evaluate(()=>localStorage.getItem('saved'));expect(JSON.parse(saved).active).toContain('bbbbbbbb');
 await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();await expect(page.getByRole('status').filter({hasText:'更新なし'})).toBeVisible();
 expect(await page.evaluate(()=>localStorage.getItem('saved'))).toBe(saved);
 await page.evaluate(()=>window.failSync=true);await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
 await expect(page.getByRole('status').filter({hasText:'確認失敗'})).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('saved'))).toBe(saved);
});

test('generic sources use declarations at a pinned commit across A B A, and reject unknown schema without adoption',async({page})=>{
 await page.addInitScript(()=>{
  window.activeRepo=localStorage.getItem('chosen')||'example/one';window.badSchema=false;window.reads=[];
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      if (command === 'acceptance_context') return null;
   const repo=window.activeRepo,second=repo==='example/two';
   if(command==='source_library')return {active:'primary',entries:[{id:'primary',name:repo,repo,episode:'P01'}]};
   if(command==='load_project')return localStorage.getItem(repo);
   if(command==='save_project'){localStorage.setItem(repo,args.data);return;}
   if(command==='source_register')return {entries:[args]};
   if(command==='backup_status')return {config:null,status:{last_success:0},restored:[],active:'primary'};
   if(command==='github_get')return JSON.stringify({sha:'c'.repeat(40)});
   if(command==='github_file'){
    if(args.repo!==repo||args.sha!=='c'.repeat(40))throw Error('Unpinned source');window.reads.push(args.path);
    if(args.path==='manifest.json')return JSON.stringify({schema_version:window.badSchema?5:1,work:repo,episodes:[{id:'P01',scene_ids:['scene']}],scenes:[{id:'scene',path:second?'novel/b.md':'text/a.md',tags:['駅']}],references:{characters:[{name:second?'B':'A',image:second?'faces/b.png':'portraits/a.png'}]}});
    return second?'作品Bの本文':'作品Aの本文';
   }
   if(command==='github_asset')return {image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',hash:'d'.repeat(64)};
   throw Error('Unexpected '+command);
  }};
 });
 await page.goto('/');
 for(const repo of ['example/one','example/two','example/one']){
  await page.evaluate(repo=>localStorage.setItem('chosen',repo),repo);
  // A reload is the native workspace switch boundary; fixture storage remains keyed by repository.
  await page.reload();await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
  await expect(page.getByRole('region',{name:'原稿の取込差分'}).or(page.getByRole('status').filter({hasText:'更新なし'}))).toBeVisible();
  if(await page.getByRole('button',{name:'取り込む',exact:true}).count())await page.getByRole('button',{name:'取り込む',exact:true}).click();
  await expect.poll(()=>page.evaluate(repo=>JSON.parse(localStorage.getItem(repo))?.snapshots.at(-1)?.repo,repo)).toBe(repo);
  const saved=await page.evaluate(repo=>JSON.parse(localStorage.getItem(repo)),repo);expect(saved.snapshots.at(-1).repo).toBe(repo);expect(saved.snapshots.at(-1).sync.source_commit).toBe('c'.repeat(40));expect(saved.snapshots.at(-1).sync.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);expect(saved.snapshots.at(-1).scenes[0].tags).toEqual(['駅']);
 }
 await page.evaluate(()=>{window.badSchema=true;window.__TAURI_INTERNALS__.invoke=new Proxy(window.__TAURI_INTERNALS__.invoke,{apply:async(target,self,args)=>args[0]==='github_get'?JSON.stringify({sha:'e'.repeat(40)}):target(...args)});});
 // Unknown version is reported before requesting any scene/asset and does not adopt.
 const before=await page.evaluate(()=>localStorage.getItem('example/one'));
 await page.evaluate(()=>{window.__TAURI_INTERNALS__.invoke=new Proxy(window.__TAURI_INTERNALS__.invoke,{apply:async(target,self,args)=>args[0]==='github_file'&&args[1].path==='manifest.json'?JSON.stringify({schema_version:5,episodes:[]}):target(...args)});});
 await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();await expect(page.getByRole('alert').filter({hasText:'schema 5 は未対応'})).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('example/one'))).toBe(before);
});

test('story-source/v1 imports the common work entry, work-root files and fixed person IDs',async({page})=>{
 await page.addInitScript(()=>{
  const repo='example/story',sha='f'.repeat(40),image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const manifest={format:'story-source/v1',work:{title:'共通作品'},episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md',tags:['駅']}]}],settings:[{id:'WORLD',path:'settings/world.md'}],characters:[{id:'yu',name:'人物A',image:'assets/yu.png',description:'固定参照'}]};
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      if (command === 'acceptance_context') return null;
   if(command==='source_library')return {active:'primary',entries:[{id:'primary',name:'共通作品',repo,episode:'P01'}]};
   if(command==='load_project')return localStorage.getItem('saved');
   if(command==='save_project'){localStorage.setItem('saved',args.data);return;}
   if(command==='source_register')return {entries:[args]};
   if(command==='backup_status')return {config:null,status:{last_success:0},restored:[],active:'primary'};
   if(command==='github_get')return JSON.stringify({sha});
   if(command==='github_file'){
    if(args.repo!==repo||args.sha!==sha)throw Error('Unpinned source');
    const files={'manifest.json':JSON.stringify(manifest),'manuscript/p01/p01-01.md':'# 場面\n\n本文です','settings/world.md':'# 世界\n\n設定です'};
    if(!(args.path in files))throw Error(`Unexpected ${args.path}`);return files[args.path];
   }
   if(command==='github_asset'){if(args.path!=='assets/yu.png')throw Error('Wrong character path');return {image,hash:'a'.repeat(64)};}
   throw Error('Unexpected '+command);
  }};
 });
 await page.goto('/');await page.getByRole('button',{name:'接続・人物設定'}).click();await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
 await expect(page.getByRole('region',{name:'原稿の取込差分'})).toContainText('P01-01');await page.getByRole('button',{name:'取り込む',exact:true}).click();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('saved')));
 expect(saved.title).toBe('共通作品');expect(saved.snapshots.at(-1).protocol.format).toBe('story-source/v1');expect(saved.snapshots.at(-1).scenes[0].tags).toEqual(['駅']);expect(saved.characters[0].source.character_id).toBe('yu');
});
