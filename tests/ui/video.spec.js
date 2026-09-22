import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('empty project opens video preparation without native credentials or a generated clip', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
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
  await page.getByLabel('動画の尺', { exact: true }).selectOption('6');
  await page.getByRole('button', { name: 'ショットを保存' }).click();
  await expect(page.locator('.video-source')).toContainText('原文です');
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByRole('button', { name: '1 · s', exact: true }).click();
  await expect(page.getByRole('heading', { name: /6秒/ })).toBeVisible();
  await expect(page.getByLabel('このショットの尺')).toHaveValue('6');
  await expect(page.getByLabel('このショットの動き')).toHaveValue('ゆっくりカメラが寄る');
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
  await drawing.getByRole('checkbox').check();
  await drawing.getByRole('button', { name: '選択コマを動画化' }).click();
  await expect(page.getByText('選択コマの動画レシピ・バッチ生成')).toBeVisible();
  await expect(page.getByLabel('s:p0の動き')).toBeVisible();
  await page.getByLabel('共通の動き').fill('人物は小さくうなずき、カメラがゆっくり寄る');
  await page.getByRole('button', { name: '共通設定を選択コマへ適用' }).click();
  await expect(page.getByLabel('s:p0の動き')).toHaveValue('人物は小さくうなずき、カメラがゆっくり寄る');
  await page.getByRole('button', { name: '選択コマの動画レシピを保存' }).click();
  await expect(page.getByRole('status')).toContainText('1コマの動画レシピを保存しました');
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
