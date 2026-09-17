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
