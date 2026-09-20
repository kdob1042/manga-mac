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
  await page.getByRole('button', { name: 'ショットを保存' }).click();
  await expect(page.locator('.video-source')).toContainText('原文です');
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByRole('button', { name: '1 · s', exact: true }).click();
  await expect(page.getByLabel('このショットの動き')).toHaveValue('ゆっくりカメラが寄る');
  await page.screenshot({ path: 'test-results/video-planning.png', fullPage: true });
  await page.getByRole('button', { name: '漫画', exact: true }).click();
  await expect(page.locator('.caption')).toHaveText(original);
});
