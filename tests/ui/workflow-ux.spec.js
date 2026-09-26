import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
const savedWork=JSON.parse(readFileSync(new URL('../fixtures/name-plan-v2-project.json',import.meta.url)));

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
  await expect(page.getByRole('img',{name:'作画ページの確認'})).toBeVisible();
  const artExports=await page.evaluate(()=>window.canvasExports);
  expect(artExports).toBeGreaterThan(0);
  await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
  await expect(page.getByTestId('layout-slot-0')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.canvasExports)).toBeGreaterThan(artExports);
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

test('page actions stay in reach while the canvas scrolls',async({page})=>{
  await openSaved(page);
  await page.addStyleTag({content:'main .page, main .page-proof { min-height: 1600px; }'});
  const main=page.locator('main');
  const scrollAndCheck=async selector=>{
    await main.evaluate(el=>{el.scrollTop=500;});
    await expect.poll(()=>main.evaluate(el=>el.scrollTop)).toBeGreaterThan(400);
    await expect.poll(async()=>{
      const bounds=await selector.boundingBox(), viewport=await main.boundingBox();
      return Math.round(bounds.y-viewport.y);
    }).toBeGreaterThanOrEqual(0);
    const bounds=await selector.boundingBox(), viewport=await main.boundingBox();
    expect(bounds.y-viewport.y).toBeLessThan(20);
  };
  const action=page.getByRole('region',{name:'作画の実行'});
  await expect(action.getByRole('button',{name:'作画するコマを選ぶ'})).toBeVisible();
  await scrollAndCheck(action);
  await page.getByRole('button',{name:'1コマ目を選択'}).click();
  await expect(action.getByRole('button',{name:/このコマの再生成候補を作る|選択した1コマを作画/})).toBeVisible();
  await page.getByRole('button',{name:'仕上げ',exact:true}).click();
  const selector=page.getByLabel('仕上げるコマ');
  await expect(selector).toBeVisible();
  await expect(page.getByRole('img',{name:'書き出しページの確認'})).toBeVisible();
  await scrollAndCheck(selector);
});

test('source sidebar moves between episodes and focuses the matching manuscript without changing it',async({page})=>{
  await page.goto('/');
  await page.evaluate(async data=>{
    const project=structuredClone(data),snapshot=project.snapshots[0];
    snapshot.scenes[0].episodeId='P01';snapshot.scenes[0].episodeTitle='第一話';
    snapshot.scenes.push({id:'S02',episodeId:'P02',episodeTitle:'第二話',text:'第二話の本文',design:''});
    snapshot.manifest={episodes:[{id:'P01',scenes:[{id:'s',title:'出会い'}]},{id:'P02',scenes:[{id:'S02',title:'再会'}]}]};
    await(await import('/src/bridge.js')).saveProject(project);
  },fixture);
  await page.reload();
  await page.getByRole('button',{name:'原稿',exact:true}).click();
  const navigation=page.getByRole('navigation',{name:'原稿の場面'});
  await expect(navigation).toContainText('第一話');
  await expect(navigation).toContainText('第二話');
  await expect(navigation.getByRole('button',{name:'S02へ移動'})).toContainText('再会');
  await navigation.getByRole('button',{name:'S02へ移動'}).click();
  const row=page.getByRole('region',{name:'原稿',exact:true}).locator('[data-source-scenes]').filter({hasText:'第二話の本文'}).first();
  await expect(row).toBeFocused();
  await expect(navigation.getByRole('button',{name:'S02へ移動'})).toHaveAttribute('aria-current','location');
  await expect.poll(()=>page.locator('main').evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  const saved=await page.evaluate(async()=>await(await import('/src/bridge.js')).loadProject());
  expect(saved.snapshots[0].scenes.find(scene=>scene.id==='S02').text).toBe('第二話の本文');
});

test('source selection action remains visible while reading a long manuscript',async({page})=>{
  await page.goto('/');
  await page.evaluate(async data=>{await(await import('/src/bridge.js')).saveProject({...data,contentToken:'fixture-token'});},savedWork);
  await page.reload();
  await page.getByRole('button',{name:'原稿',exact:true}).click();
  const toolbar=page.getByRole('region',{name:'原稿',exact:true}).locator('.toolbar');
  await expect(toolbar.getByRole('button',{name:'選択箇所を漫画に反映'})).toBeVisible();
  await page.addStyleTag({content:'.source-manuscript article { min-height: 1600px; }'});
  const main=page.locator('main');
  const toolbarOffset=await toolbar.evaluate(el=>{const scroller=el.closest('main');return el.getBoundingClientRect().top-scroller.getBoundingClientRect().top+scroller.scrollTop;});
  await main.evaluate((el,offset)=>{el.scrollTop=offset+500;},toolbarOffset);
  await expect.poll(()=>main.evaluate(el=>el.scrollTop)).toBeGreaterThan(toolbarOffset+400);
  const bounds=await toolbar.boundingBox(),viewport=await main.boundingBox();
  expect(bounds.y-viewport.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y-viewport.y).toBeLessThan(20);
});

test('initial import restores keyboard focus and keeps the action inside narrow windows',async({page})=>{
  await page.addInitScript(()=>{window.__TAURI_INTERNALS__={invoke:async command=>{
    if(command==='load_project'||command==='acceptance_context')return null;
    if(command==='source_library')return {active:'',entries:[]};
    throw Error('Fixture catalog unavailable');
  }};});
  for(const width of [1280,1440,760]){
    await page.setViewportSize({width,height:width===760?800:900});
    await page.goto('/');
    const open=page.getByRole('main').getByRole('button',{name:'GitHubのネームを開く',exact:true});
    await expect(open).toBeVisible();
    await page.screenshot({path:`test-results/entry-${width}.png`});
    await open.focus();await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog',{name:'原稿を開く'});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button',{name:'閉じる'})).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
    const bounds=await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({path:`test-results/import-${width}.png`});
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
  }
});

test('page and primary art action fit common window widths',async({page})=>{
  await openSaved(page);
  for(const width of [1280,1440,760]){
    await page.setViewportSize({width,height:width===760?800:900});
    const main=await page.locator('main').boundingBox();
    for(const item of [page.getByRole('region',{name:'作画の実行'}),page.locator('.page-proof-frame')]){
      const bounds=await item.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(main.x);
      expect(bounds.x+bounds.width).toBeLessThanOrEqual(main.x+main.width+1);
    }
    await page.screenshot({path:`test-results/art-${width}.png`});
  }
});

test('workspace A to B to A restores each saved project and a failed save blocks the switch',async({page})=>{
  await page.addInitScript(data=>{
    const workA=structuredClone(data),workB=structuredClone(data);
    workA.workId='A';workA.title='作品A';workA.snapshots[0].workId='A';
    workB.workId='B';workB.title='作品B';workB.snapshots[0].workId='B';workB.panels[0].prompt='作品Bだけの作画指示';
    if(!localStorage.getItem('work:A'))localStorage.setItem('work:A',JSON.stringify(workA));
    if(!localStorage.getItem('work:B'))localStorage.setItem('work:B',JSON.stringify(workB));
    window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      const active=localStorage.getItem('active')??'A';
      if(command==='acceptance_context')return null;
      if(command==='load_project')return localStorage.getItem(`work:${active}`);
      if(command==='save_project'){
        if(localStorage.getItem('failSave'))throw Error('保存できませんでした');
        localStorage.setItem(`work:${active}`,args.data);return;
      }
      if(command==='source_library')return {active,entries:[{id:'A',name:'作品A',work_id:'A',repo:'fixture/a',episode:'P01'},{id:'B',name:'作品B',work_id:'B',repo:'fixture/b',episode:'P01'}]};
      if(command==='backup_status')return {config:null,status:{},restored:[],active};
      if(command==='backup_open'){localStorage.setItem('active',args.workspace);location.reload();return;}
      throw Error(command);
    }};
  },savedWork);
  await page.goto('/');
  const picker=page.getByLabel('登録済み作品');
  await expect(page.locator('aside h2')).toHaveText('作品A');
  await picker.selectOption('B');
  await expect(page.locator('aside h2')).toHaveText('作品B');
  await picker.selectOption('A');
  await expect(page.locator('aside h2')).toHaveText('作品A');
  const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('work:A')));
  expect(before.panels[0].prompt).not.toBe('作品Bだけの作画指示');
  await page.evaluate(()=>localStorage.setItem('failSave','1'));
  await picker.selectOption('B');
  await expect(page.getByRole('alert')).toContainText('保存できませんでした');
  expect(await page.evaluate(()=>localStorage.getItem('active'))).toBe('A');
  await expect(picker).toHaveValue('A');
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
  await expect(page.locator('.art-page-targets polygon')).toHaveCount(fixture.panels.length);
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
  await expect(page.locator('.art-page-targets polygon')).toHaveCount(fixture.panels.length);
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
  await motion.getByText('動きの指示を調整・動画を割り当てる',{exact:true}).click();
  await motion.getByLabel('動きの指示を上書き（任意）').fill('ゆっくり振り返る');
  await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
  await page.getByRole('button',{name:'作画',exact:true}).click();
  await expect(motion.getByRole('textbox',{name:'動きの指示を上書き（任意）'})).toHaveValue('ゆっくり振り返る');
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
  expect(saved.snapshots.at(-1).scenes.map(scene=>scene.id)).toEqual(['P02-01','P02-02']);
});
