import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('local interpolation candidate adoption, persistence and undo preserve crop and lettering',async({page})=>{
 await page.goto('/');await page.evaluate(async p=>{await(await import('/src/bridge.js')).saveProject(p);},fixture);await page.reload();
 await page.locator('.panel').first().click();
 await page.getByRole('button',{name:'仕上げ',exact:true}).click();
 const before=await page.evaluate(async()=>await(await import('/src/bridge.js')).loadProject());
 await page.getByRole('button',{name:'補間拡大の候補を作る',exact:true}).click();
 await expect(page.getByRole('button',{name:'この高解像度候補を採用'})).toBeEnabled();
 await page.getByRole('button',{name:'この高解像度候補を採用'}).click();
 await expect(page.getByRole('button',{name:'この高解像度候補を採用'})).toHaveCount(0);
 await page.reload();
 const after=await page.evaluate(async()=>{const p=await(await import('/src/bridge.js')).loadProject();const {imageOf}=await import('/src/canvas-image.js');const im=await imageOf(p.panels[0].image);return {p,width:im.width,height:im.height};});
 expect(after.p.layout).toEqual(before.layout);expect(after.p.snapshots).toEqual(before.snapshots);expect(after.p.panels[0].lettering).toEqual(before.panels[0].lettering);expect(after.p.jobs.at(-1).upscale.method).toBe('canvas-high-quality-interpolation');expect(after.width).toBe(after.p.jobs.at(-1).upscale.width);
 await page.getByRole('button',{name:'↶ 元に戻す',exact:true}).click();await expect.poll(async()=>await page.evaluate(async()=>(await(await import('/src/bridge.js')).loadProject()).panels[0].image)).toBe(before.panels[0].image);
});
