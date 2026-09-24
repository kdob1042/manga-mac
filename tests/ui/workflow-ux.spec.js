import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));

async function openSaved(page){
  await page.goto('/');
  await page.evaluate(async data=>{await (await import('/src/bridge.js')).saveProject(data);},fixture);
  await page.reload();
  await expect(page.getByRole('button',{name:'作画',exact:true})).toHaveAttribute('aria-pressed','true');
}

test('stages defer expensive views, retain unfinished layout input and collect exports',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.canvasExports=0;
    const original=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=function(...args){window.canvasExports++;return original.apply(this,args);};
  });
  await openSaved(page);
  await expect(page.getByRole('region',{name:'コマ割り編集'})).toHaveCount(0);
  await expect(page.getByRole('region',{name:'セクションの完了管理'})).toHaveCount(0);
  expect(await page.evaluate(()=>window.canvasExports)).toBe(0);
  await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
  await expect(page.getByTestId('layout-slot-0')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.canvasExports)).toBeGreaterThan(0);
  await page.getByText('演出AIでこのページを配置',{exact:true}).click();
  await page.getByLabel('コマ割りの指示',{exact:true}).fill('最初のコマを大きく');
  const rendered=await page.evaluate(()=>window.canvasExports);
  await page.getByLabel('編集の指示').fill('次のコマを少し小さく');
  await page.getByRole('button',{name:'作画',exact:true}).click();
  expect(await page.evaluate(()=>window.canvasExports)).toBe(rendered);
  await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
  await expect(page.getByLabel('コマ割りの指示',{exact:true})).toHaveValue('最初のコマを大きく');
  await expect(page.getByLabel('編集の指示')).toHaveValue('次のコマを少し小さく');
  await page.getByRole('button',{name:'仕上げ',exact:true}).click();
  await expect(page.getByRole('img',{name:'書き出しページの確認'})).toBeVisible();
  await expect(page.getByRole('region',{name:'セクションの完了管理'})).toBeVisible();
  await expect(page.getByRole('button',{name:'PNG',exact:true})).toBeHidden();
  await page.getByText('書き出す',{exact:true}).click();
  await expect(page.getByRole('button',{name:'PNG',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'CBZを書き出す ↗',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/workflow-finish.png',fullPage:true});
  expect(errors).toEqual([]);
});

test('failed project load can retry without starting an empty replacement project',async({page})=>{
  await page.addInitScript(data=>{
    let attempts=0;window.saved=0;
    window.__TAURI_INTERNALS__={invoke:async command=>{
      if(command==='acceptance_context')return null;
      if(command==='load_project'){if(!attempts++)throw Error('一時的な読込エラー');return JSON.stringify(data);}
      if(command==='source_library')return {active:null,entries:[]};
      if(command==='backup_status')return {config:null,status:{},restored:[]};
      if(command==='save_project'){window.saved++;return;}
      throw Error(command);
    }};
  },fixture);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('一時的な読込エラー');
  await expect(page.getByRole('button',{name:'画面のサンプルを見る'})).toHaveCount(0);
  expect(await page.evaluate(()=>window.saved)).toBe(0);
  await page.getByRole('button',{name:'もう一度読み込む'}).click();
  await expect(page.locator('.panel')).toHaveCount(fixture.panels.length);
  expect(await page.evaluate(()=>window.saved)).toBe(1); // Existing legacy migration only.
});

test('source library failure keeps saved artwork editable and offers an independent retry',async({page})=>{
  await page.addInitScript(data=>{
    let libraryAttempts=0;
    window.__TAURI_INTERNALS__={invoke:async command=>{
      if(command==='acceptance_context')return null;
      if(command==='load_project')return JSON.stringify(data);
      if(command==='save_project')return;
      if(command==='source_library'){if(!libraryAttempts++)throw Error('一覧の読込エラー');return {active:null,entries:[]};}
      if(command==='backup_status')return {config:null,status:{},restored:[]};
      throw Error(command);
    }};
  },fixture);
  await page.goto('/');
  await expect(page.locator('.panel')).toHaveCount(fixture.panels.length);
  await expect(page.getByRole('button',{name:'接続・人物設定'})).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('保存済み作品は編集できます');
  await page.getByRole('button',{name:'原稿一覧を再読込'}).click();
  await expect(page.getByRole('button',{name:'原稿一覧を再読込'})).toHaveCount(0);
});

test('changing stages preserves unsaved panel motion and finishing choices',async({page})=>{
  await openSaved(page);
  await page.getByRole('button',{name:'1コマ目を選択'}).focus();
  await page.keyboard.press('Enter');
  const motion=page.getByRole('region',{name:'コマの動画'});
  await motion.getByText('このコマを動かす',{exact:true}).click();
  await motion.getByLabel('動きの指示',{exact:true}).fill('ゆっくり振り返る');
  await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
  await page.getByRole('button',{name:'作画',exact:true}).click();
  await expect(motion.getByRole('textbox',{name:'動きの指示',exact:true})).toHaveValue('ゆっくり振り返る');
  await page.getByRole('button',{name:'仕上げ',exact:true}).click();
  await page.getByLabel('高解像度化の倍率',{exact:true}).selectOption('4');
  await page.getByRole('button',{name:'作画',exact:true}).click();
  await page.getByRole('button',{name:'仕上げ',exact:true}).click();
  await expect(page.getByLabel('高解像度化の倍率',{exact:true})).toHaveValue('4');
  const editing=page.getByLabel('編集の指示',{exact:true});
  await editing.fill('文字を右へ');
  await editing.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  await expect(editing).toHaveValue('文字を右へ');
  await expect(page.getByRole('region',{name:'編集候補'})).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('library retry restores the saved work and second episode before importing an update',async({page})=>{
  await page.addInitScript(data=>{
    const repo='kdob1042/story-library',sha='b'.repeat(40);
    let project={...data,workId:'work-a',sourceSelection:{workId:'work-a',episodeId:'P02',sceneId:'P02-02',episodeIds:['P02'],branch:'main'}},attempts=0;
    const entry={id:'primary',name:'作品A',repo,episode:'P02',work_id:'work-a',work_root:'works/work-a',scene:'P02-02'};
    const catalog={format:'story-library/v1',authorityUntil:'M8',works:[{id:'work-a',title:'作品A',root:'works/work-a',formats:['manga'],manuscriptFormat:'story-source/v1',readAdapters:['story-source/v1'],authority:'origin',origin:{repository:'owner/a',ref:'main',commit:sha,manifestPath:'manifest.json',accessible:true},importStatus:'imported'}]};
    const manifest={format:'story-source/v1',work:{title:'作品A'},episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'}]},{id:'P02',title:'第二話',scenes:[{id:'P02-01',path:'manuscript/p02/p02-01.md'},{id:'P02-02',path:'manuscript/p02/p02-02.md'}]}],settings:[],characters:[]};
    window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      if (command === 'acceptance_context') return null;
      if(command==='load_project')return JSON.stringify(project);
      if(command==='save_project'){project=JSON.parse(args.data);window.savedProject=project;return;}
      if(command==='source_library'){if(!attempts++)throw Error('一覧の一時エラー');return {active:'primary',entries:[entry]};}
      if(command==='backup_status')return {config:null,status:{},restored:[]};
      if(command==='source_register')return {entries:[entry],id:entry.id};
      if(command==='github_get')return JSON.stringify({sha});
      if(command==='github_file'){
        if(args.repo!==repo||args.sha!==sha)throw Error('取得対象が違います');
        const files={'library.json':JSON.stringify(catalog),'migrations/source-map.json':JSON.stringify({format:'story-library-source-map/v1',authority:'origin',entries:[{workId:'work-a',origin:{repository:'owner/a'},target:{root:'works/work-a'}}]}),'works/work-a/work.json':JSON.stringify(manifest),'works/work-a/manuscript/p01/p01-01.md':'# P01-01\n\n第一話','works/work-a/manuscript/p02/p02-01.md':'# P02-01\n\n第二話前半','works/work-a/manuscript/p02/p02-02.md':'# P02-02\n\n第二話の更新本文'};
        if(!(args.path in files))throw Error(args.path);return files[args.path];
      }
      throw Error(command);
    }};
  },fixture);
  await page.goto('/');
  await page.getByRole('button',{name:'接続・人物設定'}).click();
  await expect(page.getByLabel('話ID',{exact:true})).toHaveValue('P02');
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.getByRole('button',{name:'原稿一覧を再読込'}).click();
  await page.getByRole('button',{name:'原稿',exact:true}).click();
  await page.getByRole('button',{name:'更新を確認',exact:true}).click();
  await expect(page.getByRole('region',{name:'原稿の取込差分'})).toContainText('P02-02');
  await page.getByRole('button',{name:'取り込む',exact:true}).click();
  await expect(page.getByRole('region',{name:'原稿の取込差分'})).toHaveCount(0);
  const saved=await page.evaluate(()=>window.savedProject);
  expect(saved.sourceSelection).toMatchObject({workId:'work-a',episodeId:'P02',sceneId:'P02-02'});
  expect(saved.snapshots.at(-1).scenes.map(scene=>scene.id)).toEqual(['P02-02']);
});
