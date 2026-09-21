import {test,expect} from '@playwright/test';
test('registers a second source and switches through isolated persisted works',async({page})=>{
 await page.addInitScript(()=>{
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   const entries=JSON.parse(localStorage.getItem('sources')||'[{"id":"primary","name":"作品A","repo":"owner/a","episode":"P01"}]');
   const active=localStorage.getItem('active')||'primary';
   if(command==='source_library')return {active,entries};
   if(command==='load_project')return localStorage.getItem('work:'+active);
   if(command==='save_project'){localStorage.setItem('work:'+active,args.data);return;}
   if(command==='source_register'){
    const entry={id:args.id||'second',name:args.name,repo:args.repo,episode:args.episode};
    const index=entries.findIndex(e=>e.id===entry.id);if(index<0)entries.push(entry);else entries[index]=entry;
    localStorage.setItem('sources',JSON.stringify(entries));return {entries,id:entry.id};
   }
   if(command==='backup_open'){localStorage.setItem('active',args.workspace);location.reload();return;}
   if(command==='backup_status')return {config:null,status:{last_success:0},restored:[],active};
   throw Error('Unexpected '+command);
  }};
 });
 await page.goto('/');
 await expect(page.getByLabel('登録済み作品',{exact:true})).toHaveValue('primary');
 await page.getByRole('button',{name:'作品を追加',exact:true}).click();
 await page.getByLabel('作品表示名').fill('作品B');await page.getByLabel('追加するGitHubリポジトリ').fill('owner/b');
 await page.getByLabel('最初の話ID').fill('P02');await page.getByRole('button',{name:'登録する',exact:true}).click();
 await expect(page.getByLabel('登録済み作品',{exact:true}).locator('option')).toHaveCount(2);
 await page.getByLabel('作品言語').selectOption('en');
 await page.getByLabel('登録済み作品',{exact:true}).selectOption('second');
 await expect(page.getByLabel('登録済み作品',{exact:true})).toHaveValue('second');
 await expect(page.getByLabel('作品言語')).toHaveValue('ja');
 await page.getByRole('button',{name:'接続・人物設定'}).click();
 await expect(page.getByLabel('GitHubリポジトリ',{exact:true})).toHaveValue('owner/b');
 await expect(page.getByLabel('話ID',{exact:true})).toHaveValue('P02');
 await page.getByLabel('読み取り専用トークン').fill('ephemeral');
 await page.getByLabel('登録済み作品',{exact:true}).selectOption('primary');
 await expect(page.getByLabel('作品言語')).toHaveValue('en');
 await page.getByRole('button',{name:'接続・人物設定'}).click();
 await expect(page.getByLabel('読み取り専用トークン')).toHaveValue('');
 await expect(page.getByLabel('GitHubリポジトリ',{exact:true})).toHaveValue('owner/a');
});


test('story-library work entry supports work to second episode to second scene import',async({page})=>{
 await page.addInitScript(()=>{
  const sha='a'.repeat(40),repo='kdob1042/story-library';
  const catalog={format:'story-library/v1',authorityUntil:'M8',works:[{
   id:'work-a',title:'作品A',root:'works/work-a',formats:['manga'],manuscriptFormat:'story-source/v1',
   readAdapters:['story-source/v1'],authority:'origin',
   origin:{repository:'owner/a',ref:'main',commit:'b'.repeat(40),manifestPath:'manifest.json',accessible:true},importStatus:'imported'
  }]};
  const sourceMap={format:'story-library-source-map/v1',authority:'origin',entries:[{workId:'work-a',origin:{repository:'owner/a'},target:{root:'works/work-a'}}]};
  const manifest={format:'story-source/v1',work:{title:'作品A'},episodes:[
   {id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'},{id:'P01-02',path:'manuscript/p01/p01-02.md'}]},
   {id:'P02',title:'第二話',scenes:[{id:'P02-01',path:'manuscript/p02/p02-01.md'},{id:'P02-02',path:'manuscript/p02/p02-02.md'}]}
  ],settings:[],characters:[]};
  let entry={id:'primary',name:'原稿ライブラリ',repo,episode:'P01'};
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if(command==='source_library')return {active:'primary',entries:[entry]};
   if(command==='load_project')return localStorage.getItem('story-library-project');
   if(command==='save_project'){localStorage.setItem('story-library-project',args.data);return;}
   if(command==='backup_status')return {config:null,status:{last_success:0},restored:[],active:'primary'};
   if(command==='source_register'){
    entry={...entry,id:args.id??entry.id,name:args.name,repo:args.repo,episode:args.episode,
     work_id:args.workId,work_root:args.workRoot,manifest_path:args.manifestPath,
     catalog_commit:args.catalogCommit,scene:args.scene,format:args.format};
    return {entries:[entry],id:entry.id};
   }
   if(command==='github_get'){if(args.repo!==repo||args.path!=='commits/main')throw Error('wrong head request');return JSON.stringify({sha});}
   if(command==='github_file'){
    if(args.repo!==repo||args.sha!==sha)throw Error('unpinned library read');
    const files={
     'library.json':JSON.stringify(catalog),
     'migrations/source-map.json':JSON.stringify(sourceMap),
     'works/work-a/work.json':JSON.stringify(manifest),
     'works/work-a/manuscript/p01/p01-01.md':'# P01-01\n\n本文11',
     'works/work-a/manuscript/p01/p01-02.md':'# P01-02\n\n本文12',
     'works/work-a/manuscript/p02/p02-01.md':'# P02-01\n\n本文21',
     'works/work-a/manuscript/p02/p02-02.md':'# P02-02\n\n本文22'
    };
    if(!(args.path in files))throw Error('unexpected '+args.path);return files[args.path];
   }
   throw Error('Unexpected '+command);
  }};
 });
 await page.goto('/');
 await page.getByRole('button',{name:'接続・人物設定'}).click();
 await page.getByLabel('読み取り専用トークン').fill('ephemeral');
 await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await page.getByRole('button',{name:'一覧を更新',exact:true}).click();
 await page.getByLabel('原稿ライブラリの作品').selectOption('work-a');
 await page.getByLabel('話を選ぶ').selectOption('P02');
 await page.getByRole('button',{name:'閲覧中だけ',exact:true}).click();
 await page.getByLabel('原稿ライブラリのシーン').selectOption('P02-02');
 await page.getByRole('button',{name:'接続・人物設定'}).click();
 await page.getByRole('button',{name:'GitHub側の更新を確認'}).click();
 await expect(page.getByRole('region',{name:'原稿の取込差分'})).toContainText('P02-02');
 await page.getByRole('button',{name:'取り込む',exact:true}).click();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('story-library-project')));
 expect(saved.snapshots.at(-1).selectedSceneId).toBe('P02-02');
 expect(saved.snapshots.at(-1).sync.manifest_path).toBe('works/work-a/work.json');
 expect(saved.snapshots.at(-1).scenes.map(scene=>scene.id)).toEqual(['P02-02']);
 expect(saved.snapshots.at(-1).scenes[0].text).toContain('本文22');
});
