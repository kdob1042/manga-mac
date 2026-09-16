import { test, expect } from '@playwright/test';

for (const action of ['adopt', 'abandon']) {
  test(`Blender unknown job can be ${action} without a new execution`, async ({ page }) => {
    await page.addInitScript(() => {
      window.nativeCalls = [];
      window.blenderSession = {
        session_id: 'fixture-session', revision: 0,
        state: { state: { lens: 35 } },
        jobs: [{ id: '00000000-0000-4000-8000-000000000099', status: 'unknown', expected_revision: 0 }],
      };
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        window.nativeCalls.push({ command, args });
        if (command === 'load_project') return null;
        if (command === 'blender_latest' || command === 'blender_status') return window.blenderSession;
        if (command === 'blender_recover') {
          if (args.sessionId !== 'fixture-session' || args.expectedRevision !== 0) throw Error('Wrong recovery scope');
          window.blenderSession = {
            ...window.blenderSession,
            revision: args.action === 'adopt' ? 1 : 0,
            jobs: [{ ...window.blenderSession.jobs[0], status: args.action === 'adopt' ? 'complete' : 'abandoned' }],
          };
          return window.blenderSession;
        }
        if (command === 'save_project') return null;
        throw Error(`Unexpected native command: ${command}`);
      } };
    });
    await page.goto('/');
    await page.getByRole('button', { name: '接続・人物設定' }).click();
    await expect(page.getByRole('button', { name: '撮影する', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: action === 'adopt' ? '保存結果を検証して採用' : '採用せずに解消', exact: true }).click();
    await expect(page.getByRole('button', { name: '撮影する', exact: true })).toBeEnabled();
    await expect(page.getByText(`接続版：${action === 'adopt' ? 1 : 0} ／ 焦点距離：35 mm`)).toBeVisible();
    const calls = await page.evaluate(() => window.nativeCalls);
    expect(calls.filter(call => call.command === 'blender_recover')).toHaveLength(1);
    expect(calls.some(call => call.command === 'blender_execute')).toBe(false);
    await page.screenshot({ path: `test-results/blender-recovery-${action}.png`, fullPage: true });
  });
}
