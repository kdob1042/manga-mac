import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const legacy=JSON.parse(await readFile(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('prepare motion from the selected panel uses only its source and switches to the saved shot',async({page})=>{
 await page.goto('/');await page.evaluate(async legacy=>{const {saveProject}=await import('/src/bridge.js');await saveProject(legacy);},legacy);await page.reload();await page.locator('.art-page-targets polygon').first().click();const section=page.getByRole('region',{name:'コマの動画'});await section.getByText('このコマを動かす',{exact:true}).click();await section.getByLabel('動きの指示').fill('小さくうなずく');await section.getByRole('button',{name:'この作画から動画を準備'}).click();await expect(page.getByRole('button',{name:'動画',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('heading',{name:/5秒/})).toBeVisible();
 const shot=await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js');return (await loadProject()).videoShots.at(-1);});expect(shot.unitIds).toEqual(legacy.panels[0].unitIds);expect(shot.characterIds).toEqual(legacy.panels[0].characterIds);await page.reload();await page.getByRole('button',{name:'動画',exact:true}).click();await expect(page.getByRole('navigation',{name:'動画ショット一覧'}).getByRole('button')).toHaveCount(1);
});
