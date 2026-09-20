import {test,expect} from '@playwright/test';
test('GUI settings direct asset work to Blender without offering a background executable',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'接続・人物設定'}).click();
 await expect(page.getByText('素材の追加・Asset Browser・ポーズの選択は、接続したBlenderの画面で行えます。',{exact:false})).toBeVisible();
 await expect(page.getByLabel('Blender実行ファイル',{exact:true})).toHaveCount(0);
 await page.getByText('開いているBlenderへlive接続',{exact:true}).click();
 await expect(page.getByRole('button',{name:'live接続する',exact:true})).toBeVisible();
});
