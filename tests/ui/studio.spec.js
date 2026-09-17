import { test, expect } from '@playwright/test';
test('opens a sample, preserves source on reload, and reports unavailable native operations', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: '画面のサンプルを見る' }).click();
  await expect(page.locator('.panel')).toHaveCount(4);
  await expect(page.locator('.caption').nth(1)).toHaveText('「ここ、空いてる？」');
  await page.reload();
  await expect(page.locator('.panel')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/studio.png', fullPage: true });
  await page.getByRole('button', { name: '接続・人物設定' }).click();
  await page.getByRole('button', { name: 'GitHub側の更新を確認' }).click();
  await expect(page.getByRole('alert')).toContainText('Macアプリ');
  expect(errors).toEqual([]);
});

test('planning connection has no face estimator; keys are ephemeral', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '接続・人物設定' }).click();
  await page.getByLabel('演出・コマ計画の接続先').selectOption('gemini');
  await page.getByLabel('演出・コマ計画のモデルID').fill('example-model');
  await page.getByLabel('演出・コマ計画のAPIキー').fill('test-secret');
  await expect(page.getByLabel('顔の範囲推定の接続先')).toHaveCount(0);
  await expect(page.getByText('脚本・設定・人物の説明を送信します。', { exact: false })).toBeVisible();
  await page.getByLabel('演出・コマ計画の接続先').selectOption('anthropic');
  await expect(page.getByLabel('演出・コマ計画のAPIキー')).toHaveValue('');
  await page.reload();
  await page.getByRole('button', { name: '接続・人物設定' }).click();
  await expect(page.getByLabel('演出・コマ計画の接続先')).toHaveValue('ollama');
});


test('switches manga content between Japanese source and shared English localization', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '画面のサンプルを見る' }).click();
  await expect(page.locator('.caption').nth(1)).toHaveText('「ここ、空いてる？」');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('manga-mac', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('data', 'readwrite');
      const store = tx.objectStore('data');
      const get = store.get('project');
      get.onsuccess = () => {
        const project = get.result;
        project.version = 3;
        project.output_locale = 'en';
        project.localizations = [{
          id: 'sample:en', snapshot_id: 'sample', locale: 'en',
          units: [
            { id: 'S01:u0', text: 'After school in the library. Light enters through the window.' },
            { id: 'S01:u1', text: '“Is this seat free?”' },
            { id: 'S01:u2', text: 'She looks up and pulls out the chair beside her.' },
            { id: 'S01:u3', text: '“Go ahead.”' },
          ],
          model: { provider: 'fixture', model: 'fixture' }, created_at: '2026-09-16T00:00:00.000Z',
        }];
        store.put(project, 'project');
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
  await page.reload();
  await expect(page.getByLabel('作品言語')).toHaveValue('en');
  await expect(page.locator('.caption').nth(1)).toHaveText('“Is this seat free?”');
  await expect(page.getByRole('button', { name: '接続・人物設定' })).toBeVisible();
  await page.getByLabel('作品言語').selectOption('ja');
  await expect(page.locator('.caption').nth(1)).toHaveText('「ここ、空いてる？」');
});
