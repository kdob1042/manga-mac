// IPC fixture only: does not prove MLX inference or Mac playback.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('local registration routes only to MLX and stores a candidate before explicit adoption', async ({ page }) => {
  await page.addInitScript(legacy => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const project = () => JSON.parse(sessionStorage.getItem('fixture-project') || JSON.stringify(legacy));
      if (command === 'source_library') return { active: 'primary', entries: [{ id: 'primary', name: 'Fixture', repo: 'example/story', episode: 'P01' }] };
      if (command === 'load_project') return JSON.stringify(project());
      if (command === 'save_project') { sessionStorage.setItem('fixture-project', args.data); return; }
      if (command === 'register_local_video') {
        sessionStorage.setItem('fixture-config', JSON.stringify(args.input)); return 'local-fixture';
      }
      if (command === 'remove_local_video') return;
      if (command === 'local_video_submit') {
        const p = project(), job = p.jobs.find(j => j.id === args.jobId);
        if (!job || job.manifest.connection.provider !== 'ltx-mlx' || job.manifest.ratio !== '512:512') throw Error('Wrong local request');
        job.remote = { provider: 'ltx-mlx', status: 'SUCCEEDED', artifact: { artifact_id: 'a'.repeat(64), hash: 'a'.repeat(64), mime: 'video/mp4', size: 1838 } };
        sessionStorage.setItem('fixture-project', JSON.stringify(p)); return job.remote.artifact;
      }
      if (command === 'video_playback') {
        const v = project().videoRevisions.find(v => v.id === args.revisionId);
        return { path: '/fixture/not-real.mp4', artifact: v.artifact };
      }
      throw Error(`Unexpected IPC (including external fallback): ${command}`);
    } };
  }, legacy);
  await page.goto('/');
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByLabel('動画の生成先', { exact: true }).selectOption('ltx-mlx');
  await page.getByLabel('ltx-2-mlx実行ファイル', { exact: true }).fill('/fixture/bin/ltx-2-mlx');
  await page.getByLabel('モデルフォルダ', { exact: true }).fill('/fixture/models/ltx-2.5-mlx-q4');
  await page.getByLabel('モデルの利用条件を確認し、このCLIでのローカル実行を許可する').check();
  await page.getByRole('button', { name: 'ローカル接続を登録する', exact: true }).click();
  await page.getByLabel('原作の場面', { exact: true }).selectOption('s');
  await page.getByLabel('開始画像', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('動きの指示', { exact: true }).fill('Camera gently moves forward.');
  await page.getByLabel('動画の寸法', { exact: true }).selectOption('512:512');
  await page.getByRole('button', { name: 'ショットを保存', exact: true }).click();
  await page.getByRole('button', { name: '5秒の動画を生成する', exact: true }).click();
  await expect(page.getByText(/ローカル動画候補を保存しました/)).toBeVisible();
  let p = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-project')));
  expect(p.videoRevisions).toHaveLength(1);
  expect(p.videoShots[0].adopted_revision).toBeNull();
  expect(p.jobs.at(-1).cost.kind).toBe('local');
  expect(p.history).toEqual(legacy.history);
  await page.getByRole('button', { name: 'この動画を採用', exact: true }).click();
  await expect(page.getByText(/採用中 ·/)).toBeVisible();
  await page.reload();
  p = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-project')));
  expect(p.videoRevisions).toHaveLength(1);
  expect(p.jobs.filter(j => j.kind === 'video')).toHaveLength(1);
  expect(p.videoShots[0].adopted_revision).toBe(p.videoRevisions[0].id);
});
