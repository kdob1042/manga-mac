import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('video capture uses the shared controls without creating manga panels; restart retains the source', async ({ page }) => {
  await page.addInitScript(({ legacy }) => {
    const initial = { ...legacy, panels: [], history: [], jobs: [] };
    const hash = 'a'.repeat(64), image = legacy.characters[0];
    const state = { dependencies_pinned: true, checkpoint: { hash }, state: { scene: 'Stage', camera: 'Camera', frame: 1, lens: 50 }, scenes: [{ name: 'Stage', cameras: ['Camera'], objects: ['Actor'] }] };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const sessions = JSON.parse(sessionStorage.getItem('fixture-sessions') || '{}');
      if (command === 'load_project') return sessionStorage.getItem('fixture-project') || JSON.stringify(initial);
      if (command === 'save_project') { sessionStorage.setItem('fixture-project', args.data); return; }
      if (command === 'blender_latest') return { session_id: 'base', revision: 1, state };
      if (command === 'blender_fork') {
        const results = args.ids.map(id => ({ session_id: id, revision: 0, state, jobs: [] }));
        results.forEach(s => { sessions[s.session_id] = s; }); sessionStorage.setItem('fixture-sessions', JSON.stringify(sessions)); return results;
      }
      if (command === 'blender_status') return sessions[args.sessionId];
      if (command === 'blender_execute') {
        const r = args.request, s = sessions[r.session_id];
        if (r.operation.kind !== 'capture') throw Error('unexpected fixture operation');
        const result = { ...s, request_id: r.request_id, revision: s.revision + 1, preview: image.image, jobs: [{ id: r.request_id, status: 'complete' }], state: { ...state, image: { hash: image.hash }, state: { ...state.state, resolution: [r.operation.width, r.operation.height] } } };
        sessions[r.session_id] = result; sessionStorage.setItem('fixture-sessions', JSON.stringify(sessions)); return result;
      }
      throw Error(`Unexpected fixture IPC: ${command}`);
    } };
  }, { legacy });
  await page.goto('/');
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByLabel('原作の場面', { exact: true }).selectOption('s');
  await page.getByText('共有Blender素材から動画用に撮影', { exact: true }).click();
  await page.getByLabel('撮影する人物', { exact: true }).selectOption(['a']);
  await page.getByRole('button', { name: '動画用の撮影ショットを作る', exact: true }).click();
  await page.getByRole('button', { name: '構図・素材を読み込む', exact: true }).click();
  await page.getByRole('button', { name: 'この動画用撮影を撮影', exact: true }).click();
  await page.getByRole('button', { name: 'この撮影を開始画像に使う', exact: true }).click();
  await page.getByLabel('動きの指示', { exact: true }).fill('カメラを固定する');
  await page.getByRole('button', { name: 'ショットを保存', exact: true }).click();
  await expect(page.locator('.video-source')).toContainText('原文です');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-project')));
  expect(saved.panels).toEqual([]); expect(saved.history).toEqual([]);
  expect(saved.captures).toHaveLength(1); expect(saved.videoShots[0].characterIds).toEqual(['a']);
  expect(saved.captures[0].settings.resolution).toEqual([960, 960]);
  await page.screenshot({ path: 'test-results/video-independent-capture.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByRole('button', { name: '1 · s', exact: true }).click();
  await expect(page.getByText('カメラを固定する', { exact: true })).toBeVisible();
});
