import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('empty project opens video preparation without native credentials or a generated clip', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.video-workspace')).toHaveCount(0);
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await expect(page.getByRole('heading', { name: '動画ショット' })).toBeVisible();
  await expect(page.getByText('接続・人物設定から原作を取得してください。')).toBeVisible();
  expect(errors).toEqual([]);
});

test('video planning shares artwork and survives reload without changing manga', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(project => new Promise((resolve, reject) => {
    const open = indexedDB.open('manga-mac', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('data', 'readwrite');
      tx.objectStore('data').put(project, 'project');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), legacy);
  await page.reload();
  await expect(page.locator('.panel')).toHaveCount(1);
  const original = await page.locator('.caption').textContent();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByLabel('原作の場面').selectOption('s');
  await page.getByLabel('開始画像').selectOption({ index: 1 });
  await page.getByLabel('動きの指示').fill('ゆっくりカメラが寄る');
  await page.getByRole('button', { name: '漫画', exact: true }).click();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await expect(page.getByLabel('動きの指示')).toHaveValue('ゆっくりカメラが寄る');
  await page.getByLabel('動画の尺', { exact: true }).selectOption('6');
  await page.getByRole('button', { name: 'ショットを保存' }).click();
  await expect(page.locator('.video-source')).toContainText('原文です');
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByRole('button', { name: '1 · s', exact: true }).click();
  await expect(page.getByRole('heading', { name: /6秒/ })).toBeVisible();
  await expect(page.getByLabel('このショットの尺')).toHaveValue('6');
  await expect(page.getByLabel('このショットの動き')).toHaveValue('ゆっくりカメラが寄る');
  await page.getByLabel('このショットの動き').fill('人物が小さくうなずく');
  await expect(page.getByText('変更した指示を保存すると生成できます。')).toBeVisible();
  await page.getByRole('button', {name:'指示を保存する',exact:true}).click();
  await expect(page.getByText('変更した指示を保存すると生成できます。')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/video-planning.png', fullPage: true });
  await page.getByRole('button', { name: '漫画', exact: true }).click();
  await expect(page.locator('.caption')).toHaveText(original);
});

test('selected manga panels become editable video recipes before any batch submission', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(project => new Promise((resolve, reject) => {
    const open = indexedDB.open('manga-mac', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('data', 'readwrite');
      tx.objectStore('data').put(project, 'project');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), legacy);
  await page.reload();
  const drawing = page.getByRole('region', { name: '参照付き作画' });
  await drawing.getByRole('checkbox', {name:/^1コマ目/}).check();
  await drawing.getByRole('button', { name: '選択コマを動画化' }).click();
  await expect(page.getByText('選択コマの動画レシピ・バッチ生成')).toBeVisible();
  await expect(page.getByLabel('s:p0の動き')).toBeVisible();
  await page.getByLabel('共通の動き').fill('人物は小さくうなずき、カメラがゆっくり寄る');
  await expect(page.getByLabel('s:p0の動き')).toHaveValue('人物は小さくうなずき、カメラがゆっくり寄る');
  await page.getByLabel('s:p0の動き').fill('このコマだけ手を振る');
  await page.getByLabel('共通の動き').fill('共通の動きを変更');
  await expect(page.getByLabel('s:p0の動き')).toHaveValue('このコマだけ手を振る');
  await page.getByRole('button', { name: '共通設定に戻す' }).click();
  await expect(page.getByLabel('s:p0の動き')).toHaveValue('共通の動きを変更');
  await page.getByRole('button', { name: '選択コマの動画レシピを保存' }).click();
  await expect(page.getByRole('status').filter({hasText:'1コマの動画レシピを保存しました'})).toBeVisible();
  await expect(page.getByRole('button', {name:'選択コマの動画レシピを保存'})).toBeDisabled();
  await expect(page.getByRole('navigation', { name: '動画ショット一覧' }).getByRole('button')).toHaveCount(1);
  expect(await page.evaluate(async () => {
    const { loadProject } = await import('/src/bridge.js');
    const saved = await loadProject();
    const shot = saved.videoShots[0];
    return { sourcePanelId: shot.sourcePanelId, batchId: shot.batchId, jobs: saved.jobs.filter(job => job.kind === 'video').length };
  })).toMatchObject({ sourcePanelId: 's:p0', jobs: 0 });
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '動画ショット一覧' }).getByRole('button')).toHaveCount(1);
});

for (const scope of ['common', 'individual']) test(`video model changes invalidate saved ${scope} batch settings and allow repairs`, async ({ page }) => {
  await page.addInitScript(fixture => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'source_library') return { active:'primary', entries:[{id:'primary',name:'Fixture',repo:'example/story',episode:'P01'}] };
      if (command === 'load_project') return sessionStorage.getItem('video-model-project') || JSON.stringify({...fixture,mediaDefaults:{video:'runway-seedance-2-5'}});
      if (command === 'save_project') { sessionStorage.setItem('video-model-project',args.data); return; }
      if (command === 'backup_status') return {config:null,status:{},restored:[]};
      throw Error(`Unexpected IPC: ${command}`);
    }};
  }, legacy);
  await page.goto('/');
  const drawing = page.getByRole('region',{name:'参照付き作画'});
  await drawing.getByRole('checkbox',{name:/^1コマ目/}).check();
  await drawing.getByRole('button',{name:'選択コマを動画化'}).click();
  await page.getByLabel('共通の動き').fill('人物がゆっくりうなずく');
  if (scope === 'common') {
    await page.getByLabel('共通の動画尺').selectOption('20');
    await page.getByLabel('共通の動画寸法').selectOption('1440:1440');
  } else {
    await page.getByLabel('s:p0の尺').selectOption('25');
    await page.getByLabel('s:p0の寸法').selectOption('640:640');
  }
  const save = page.getByRole('button',{name:'選択コマの動画レシピを保存'});
  await save.click();
  await expect(save).toBeDisabled();
  await page.getByRole('region',{name:'動画バッチ実行確認'}).getByRole('checkbox').check();
  await page.getByText('動画API接続',{exact:true}).click();
  await page.getByLabel('動画の生成先').selectOption('runway-gen4-5');
  await expect(page.getByRole('region',{name:'動画バッチ実行確認'})).toHaveCount(0);
  await expect(page.getByLabel('s:p0の寸法')).toBeEnabled();
  await expect(page.getByLabel('s:p0の尺')).toBeEnabled();
  if (scope === 'common') {
    await expect(page.getByLabel('共通の動画尺')).toHaveValue('5');
    await expect(page.getByLabel('共通の動画寸法')).toHaveValue('1280:720');
  } else {
    await expect(page.getByLabel('s:p0の尺')).toHaveValue('25');
    await expect(page.getByLabel('s:p0の寸法')).toHaveValue('640:640');
    await expect(page.getByLabel('s:p0の尺').locator('option:checked')).toContainText('モデル非対応');
  }
  await page.getByLabel('s:p0の寸法').selectOption('960:960');
  await page.getByLabel('s:p0の尺').selectOption('5');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('region',{name:'動画バッチ実行確認'}).getByRole('checkbox')).not.toBeChecked();
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('video-model-project')));
  expect(saved.videoShots.map(shot=>[shot.duration,shot.ratio])).toEqual([scope==='common'?[20,'1440:1440']:[25,'640:640'],[5,'960:960']]);
  expect(saved.jobs.filter(job=>job.kind==='video')).toHaveLength(0);
});
