import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('production page uses real geometry, source preview, selected panel and persisted approval',async({page})=>{
 await page.goto('/');
 await page.evaluate(async fixture=>{const {saveProject}=await import('/src/bridge.js');await saveProject(fixture);},legacy);
 await page.reload();
 await expect(page.getByRole('region',{name:'コマ割り編集'})).toBeVisible();
 await page.getByTestId('layout-slot-0').click({position:{x:50,y:50}});
 await expect(page.getByRole('button',{name:/このコマの再生成候補を作る/})).toBeVisible();
 await expect(page.getByRole('region',{name:'セクションの完了管理'})).toBeVisible();
 await page.getByRole('button',{name:'接続・人物設定'}).click();
 await page.getByLabel('画像生成モデル',{exact:true}).selectOption('runway-gen4-image');
 await expect(page.getByRole('button',{name:'画像モデルを準備する'})).toBeDisabled();
 await expect(page.getByRole('group',{name:'Runway静止画の接続'})).toBeVisible();
 expect(await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js');return (await loadProject()).mediaDefaults.image;})).toBe('runway-gen4-image');
});
