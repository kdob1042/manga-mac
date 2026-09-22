import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import JSZip from 'jszip';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));

async function openSaved(page) {
  await page.goto('/');
  await page.evaluate(async data=>{await (await import('/src/bridge.js')).saveProject(data);},fixture);
  await page.reload();
  await expect(page.locator('.panel').first()).toBeVisible();
}

test('PNG and CBZ render at chosen dimensions and leave source, artwork, placement and jobs unchanged',async({page})=>{
  await openSaved(page);
  const result=await page.evaluate(async()=>{
    const {loadProject}=await import('/src/bridge.js'),{pagePNG}=await import('/src/render.js'),{pagePanels}=await import('/src/layout.js'),{exportCBZ}=await import('/src/export.js');
    const p=await loadProject(),before=JSON.stringify(p),pg=p.layout.pages[0];
    const png=await pagePNG(pagePanels(p,pg),p.snapshots,p.localizations,p.output_locale,pg,false,p.layout.imageCrops,{width:800});
    const image=new Image();image.src=png;await image.decode();
    const large=await pagePNG(pagePanels(p,pg),p.snapshots,p.localizations,p.output_locale,pg,false,p.layout.imageCrops,{width:3200});
    const big=new Image();big.src=large;await big.decode();
    return {png,size:[image.width,image.height],large:[big.width,big.height],unchanged:before===JSON.stringify(p),zip:Array.from(new Uint8Array(await (await exportCBZ(p,{width:800})).arrayBuffer()))};
  });
  expect(result.size).toEqual([800,1130]);expect(result.large).toEqual([3200,4520]);expect(result.unchanged).toBe(true);
  const zip=await JSZip.loadAsync(result.zip);
  expect(await zip.file('001.png').async('base64')).toBe(result.png.split(',')[1]);
  expect(JSON.parse(await zip.file('provenance.json').async('string')).output).toEqual({width:800,height:1130});
});

test('export width survives closing menu; resolution warning opens the affected panel without generation',async({page})=>{
  await openSaved(page);
  await page.getByRole('button',{name:'動画',exact:true}).click();
  await page.getByText('書き出す',{exact:true}).click();
  await page.getByLabel('PNG・CBZの出力幅').selectOption('3200');
  await page.getByText('書き出す',{exact:true}).click();
  await page.getByText('書き出す',{exact:true}).click();
  await expect(page.getByLabel('PNG・CBZの出力幅')).toHaveValue('3200');
  await page.getByText(/画像解像度を確認 · 全体で/).click();
  await page.getByRole('button',{name:'1ページ · 1コマ目',exact:true}).click();
  await expect(page.getByRole('button',{name:'仕上げ',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByLabel('仕上げるコマ')).toHaveValue(fixture.panels[0].id);
  await expect(page.getByLabel('仕上げるコマ')).toBeVisible();
  await expect(page.getByLabel('PNG・CBZの出力幅')).toBeHidden();
  const p=await page.evaluate(async()=>await (await import('/src/bridge.js')).loadProject());
  expect(p.jobs).toEqual(fixture.jobs);expect(p.panels.map(p=>p.image)).toEqual(fixture.panels.map(p=>p.image));
});

test('adjacent artwork mounts only on demand and closes without leaving hidden reference images',async({page})=>{
  await openSaved(page);
  await page.locator('.panel').first().click();
  await expect(page.getByRole('img',{name:'選択中のコマ',exact:true})).toHaveCount(0);
  await page.getByText('前後のコマ・人物参照',{exact:true}).click();
  await expect(page.getByRole('img',{name:'選択中のコマ',exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'次のコマ',exact:true})).toHaveCount(0);
  await page.screenshot({path:'test-results/artwork-context.png',fullPage:true});
  await page.getByText('前後のコマ・人物参照',{exact:true}).click();
  await expect(page.getByRole('img',{name:'選択中のコマ',exact:true})).toHaveCount(0);
});
