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
  await page.getByRole('button', { name: '更新を確認する' }).click();
  await expect(page.getByRole('alert')).toContainText('Macアプリ');
  expect(errors).toEqual([]);
});
