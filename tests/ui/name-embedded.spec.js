import {test,expect} from '@playwright/test';

test('empty app imports two names without a manuscript and registers an image by fixed ID',async({page})=>{
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'ネームを開く',exact:true})).toBeVisible();
 const files=await page.evaluate(async()=>{
  const {fixture}=await import('/tests/name-plan-fixture.mjs'),{createNameFile}=await import('/src/name-v2.js');
  const f=fixture(1,'# 当時の原文\n\n「こんにちは」');f.snapshot.characters=[{id:'yumi',name:'由美'}];f.plan.panels[0].characterIds=['yumi'];
  return Promise.all([1,2].map(number=>createNameFile(f.project,f.plan,null,{producer:'fixture',model:'',editedBy:[]},{number})));
 });
 const upload=file=>({name:`name-${file.source.number}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(file))});
 await page.getByLabel('ネームJSONを開く',{exact:true}).setInputFiles(upload(files[0]));
 await page.getByRole('button',{name:'実文字入り仮ネームを確認',exact:true}).click();
 await expect(page.getByAltText('実際のコマ枠と掲載文字による仮ネーム')).toBeVisible();
 await page.getByRole('button',{name:'このネーム候補を採用',exact:true}).click();
 await page.getByText('人物の参照画像',{exact:true}).click();
 await expect(page.getByText('参照画像がありません。この人物を描くコマの作画時に必要です。',{exact:true})).toBeVisible();
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 await page.getByLabel('yumiの参照画像',{exact:true}).setInputFiles({name:'yumi.png',mimeType:'image/png',buffer:png});
 await page.getByLabel('ネームJSONを取り込む',{exact:true}).setInputFiles(upload(files[1]));
 await page.getByRole('button',{name:'このネーム候補を採用',exact:true}).click();
 await expect(page.getByLabel('採用したネーム',{exact:true}).locator('option')).toHaveCount(2);
 await page.reload();
 await expect(page.getByLabel('採用したネーム',{exact:true}).locator('option')).toHaveCount(2);
 const saved=await page.evaluate(async()=> (await import('/src/bridge.js')).loadProject());
 expect(saved.snapshots.every(s=>s.embeddedName)).toBe(true);expect(saved.panels).toHaveLength(2);expect(saved.characters).toHaveLength(1);expect(saved.characters[0].image).toBeTruthy();
});
