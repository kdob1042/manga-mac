import {test,expect} from '@playwright/test';

test('GitHub page adoption automatically registers pinned character references and survives reload',async({page})=>{
  await page.addInitScript(()=>{
    window.referenceCalls=[];
    window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      if(command==='acceptance_context')return null;
      if(command==='source_library')return {active:'primary',entries:[{id:'primary',name:'参照試験',repo:'fixture/stories',episode:'P01',work_id:'example'}]};
      if(command==='load_project')return localStorage.getItem('reference-project');
      if(command==='save_project'){localStorage.setItem('reference-project',args.data);return;}
      if(command==='backup_status')return {config:null,status:{last_success:0},restored:[],active:'primary'};
      if(command==='live_preview_list')return [];
      if(command==='github_get')return JSON.stringify({sha:'a'.repeat(40)});
      if(command==='github_file'){
        window.referenceCalls.push({command,...args});
        if(args.sha!=='a'.repeat(40))throw Error('unpinned read');
        if(args.path.endsWith('/episode.json'))return localStorage.getItem('reference-manifest');
        if(args.path.endsWith('/work.json'))return JSON.stringify({format:'story-source/v1',work:{title:'試験'},episodes:[{id:'P01',title:'話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'}]}],settings:[],characters:[{id:'yumi',name:'由美子',image:'assets/yumi.png'}]});
        if(args.path.includes('/pages/'))return localStorage.getItem('reference-page');
      }
      if(command==='github_asset'){
        window.referenceCalls.push({command,...args});
        if(args.sha!=='a'.repeat(40)||args.path!=='works/example/assets/yumi.png')throw Error('unpinned asset');
        return {image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',hash:'b'.repeat(64)};
      }
      throw Error('Unexpected native call: '+command);
    }};
  });
  await page.goto('/');
  await page.evaluate(async()=>{
    const {fixture}=await import('/tests/name-plan-fixture.mjs');
    const {createNameFile}=await import('/src/name-v2.js');
    const {embeddedV2ToEpisode}=await import('/contracts/name-plan/convert.mjs');
    const {splitEpisodeFiles}=await import('/contracts/name-plan/page.mjs');
    const f=fixture(1,'# 当時の原文\n\n「こんにちは」');f.snapshot.characters=[{id:'yumi',name:'由美子'}];f.plan.panels[0].characterIds=['yumi'];
    const file=await createNameFile(f.project,f.plan,null,{producer:'fixture',model:'',editedBy:[]},{number:1});
    const episode=await embeddedV2ToEpisode(file),{manifest,pages}=splitEpisodeFiles(episode);
    localStorage.setItem('reference-manifest',JSON.stringify(manifest));localStorage.setItem('reference-page',JSON.stringify(pages[manifest.pageIds[0]]));
  });
  await page.getByText('GitHubからページを取得',{exact:true}).click();
  await page.getByRole('textbox',{name:'リポジトリ',exact:true}).fill('fixture/stories');
  await page.getByRole('textbox',{name:'作品root',exact:true}).fill('works/example');
  await page.getByRole('button',{name:'ページ一覧を取得',exact:true}).click();
  await page.locator('.name-plan-controls input[type=checkbox]').check();
  await page.getByRole('button',{name:'選択ページを読み込む',exact:true}).click();
  await expect(page.getByText(/人物参照1件も同じ版から取得しました/)).toBeVisible();
  await page.getByRole('button',{name:'選択ページを採用',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'ページ',exact:true})).toBeVisible();
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('reference-project')));
  expect(saved.characters).toHaveLength(1);expect(saved.characters[0].image).toBeTruthy();
  expect(saved.panels[0].characterIds).toEqual([saved.characters[0].id]);
  expect(saved.nameEpisodes[JSON.stringify(['example','P01'])].characters[0].id).toBe('yumi');
  expect(await page.evaluate(()=>window.referenceCalls.some(call=>call.path.includes('/manuscript/')))).toBe(false);
  await page.reload();
  const reloaded=await page.evaluate(()=>JSON.parse(localStorage.getItem('reference-project')));
  expect(reloaded.characters).toEqual(saved.characters);expect(reloaded.panels[0].characterIds).toEqual(saved.panels[0].characterIds);
});
