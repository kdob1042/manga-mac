import { test, expect } from '@playwright/test';

test('downloads, catalogs and imports a licensed web asset through the Blender bridge', async ({ page }) => {
  await page.addInitScript(() => {
    window.nativeCalls = [];
    window.blenderSession = {
      session_id: 'fixture-session', revision: 1, jobs: [],
      state: { state: { lens: 35 }, library_assets: [] },
    };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.nativeCalls.push({ command, args });
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'kdob1042/Kamiya-Kawai',episode:'P01'}]};
      if (command === 'load_project') return null;
      if (command === 'blender_latest' || command === 'blender_status') return structuredClone(window.blenderSession);
      if (command === 'blender_download_web_asset') {
        if (args.sessionId !== 'fixture-session' || args.expectedRevision !== 1) throw Error('Wrong download scope');
        return {
          file: 'download-id/actor.zip', hash: 'a'.repeat(64), bytes: 2048,
          source_url: 'https://cdn.example/actor.zip',
          source_page: 'https://assets.example/actor', license: 'CC0 1.0',
        };
      }
      if (command === 'blender_execute') {
        const operation = args.request.operation;
        if (operation.kind === 'webcatalog') {
          window.blenderSession = {
            ...window.blenderSession, revision: 2,
            state: { ...window.blenderSession.state, web_asset_candidates: [{
              entry: 'actor.glb', format: 'glb', asset_type: null, name: null,
              label: 'actor.glb',
            }] },
          };
          return structuredClone(window.blenderSession);
        }
        if (operation.kind === 'webimport') {
          if (args.request.expected_revision !== 2 || operation.license !== 'CC0 1.0') throw Error('Wrong import scope');
          window.blenderSession = {
            ...window.blenderSession, revision: 3,
            state: { ...window.blenderSession.state, web_asset_candidates: null,
              imported_web_asset: { entry: operation.entry, license: operation.license } },
          };
          return structuredClone(window.blenderSession);
        }
      }
      if (command === 'save_project') return null;
      throw Error(`Unexpected native command: ${command}`);
    } };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '接続・人物設定' }).click();
  await page.getByText('Webの既存3D素材を取り込む').click();
  await page.getByLabel('素材のダウンロードURL').fill('https://cdn.example/actor.zip?token=temporary');
  const inspect = page.getByRole('button', { name: '取得して内容を確認' });
  await expect(inspect).toBeDisabled();
  await page.getByLabel('配布ページURL（任意）').fill('https://assets.example/actor');
  await page.getByLabel('ライセンス表記').fill('CC0 1.0');
  await expect(inspect).toBeEnabled();
  await inspect.click();
  await expect(page.getByText('取得済み：download-id/actor.zip（2 KB）')).toBeVisible();
  await page.getByLabel('取り込むWeb素材').selectOption('0');
  await page.getByRole('button', { name: '選択したWeb素材を舞台へ取り込む' }).click();
  await expect(page.getByText('接続版：3 ／ 焦点距離：35 mm')).toBeVisible();
  const calls = await page.evaluate(() => window.nativeCalls);
  expect(calls.map(call => call.command)).toContain('blender_download_web_asset');
  expect(calls.filter(call => call.command === 'blender_execute').map(call => call.args.request.operation.kind))
    .toEqual(['webcatalog', 'webimport']);
  const imported = calls.find(call => call.args?.request?.operation?.kind === 'webimport').args.request.operation;
  expect(imported).toMatchObject({
    file: 'download-id/actor.zip', entry: 'actor.glb', format: 'glb',
    source_url: 'https://cdn.example/actor.zip', source_page: 'https://assets.example/actor',
    license: 'CC0 1.0',
  });
  await page.screenshot({ path: 'test-results/web-asset-import.png', fullPage: true });
});
