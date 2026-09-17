import { test, expect } from '@playwright/test';
test('registration clears UI key; normal typed jobs use only the connection ID', async ({ page }) => {
  await page.addInitScript(() => {
    window.nativeCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.nativeCalls.push({ command, args });
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'kdob1042/Kamiya-Kawai',episode:'P01'}]};
      if (command === 'load_project') return null;
      if (command === 'register_llm') return 'registered-fixture';
      if (command === 'llm_request') return { request_id: args.request.request_id, value: { ok: true } };
      if (command === 'remove_llm' || command === 'save_project') return null;
      throw Error('Unexpected native command');
    } };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '接続・人物設定' }).click();
  await page.getByLabel('演出・コマ計画の接続先').selectOption('openai');
  await page.getByLabel('演出・コマ計画のモデルID').fill('fixture-model');
  await page.getByLabel('演出・コマ計画のAPIキー').fill('fixture-secret');
  await page.getByRole('button', { name: '接続をテスト' }).first().click();
  await expect(page.getByLabel('演出・コマ計画のAPIキー')).toHaveValue('');
  await expect(page.getByText('接続を登録済み（この起動中のみ）')).toBeVisible();
  const calls = await page.evaluate(() => window.nativeCalls);
  expect(calls.find(c => c.command === 'register_llm').args.input.credential).toBe('fixture-secret');
  const request = calls.find(c => c.command === 'llm_request').args.request;
  expect(request.connection_id).toBe('registered-fixture');
  expect(JSON.stringify(request)).not.toContain('fixture-secret');
  expect(request).not.toHaveProperty('endpoint');
  expect(request).not.toHaveProperty('body');
  await page.screenshot({ path: 'test-results/llm-registration.png', fullPage: true });
  await page.getByLabel('演出・コマ計画の接続先').selectOption('anthropic');
  await expect(page.getByLabel('演出・コマ計画のAPIキー')).toHaveValue('');
  await expect.poll(() => page.evaluate(() => window.nativeCalls.some(c => c.command === 'remove_llm' && c.args.connectionId === 'registered-fixture'))).toBe(true);
});
