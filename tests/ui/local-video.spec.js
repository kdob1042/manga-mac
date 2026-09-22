// IPC fixture only: does not prove MLX inference or Mac playback.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { migrateProject } from '../../src/revisions.js';
import { ensureLayout } from '../../src/layout.js';
import { upgradeSourceProject } from '../../src/source-application.js';
import { createPanelVideoShots } from '../../src/video-batch.js';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('local registration routes only to MLX and stores a candidate before explicit adoption', async ({ page }) => {
  await page.addInitScript(legacy => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'acceptance_context') return null;
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
  await page.getByText('動画API接続', { exact: true }).click();
  await page.getByLabel('動画の生成先', { exact: true }).selectOption('ltx-2-5-mlx-local');
  await page.getByLabel('LTX実行ファイル', { exact: true }).fill('/fixture/bin/ltx-2-mlx');
  await page.getByLabel('LTXモデルフォルダ', { exact: true }).fill('/fixture/models/ltx-2.5-mlx-q4');
  await page.getByLabel('FFmpeg実行ファイル', { exact: true }).fill('/fixture/bin/ffmpeg');
  await page.getByLabel('ローカルモデルの利用条件を確認し、動画生成を許可する').check();
  await page.getByRole('button', { name: 'ローカル接続を登録する', exact: true }).click();
  await page.getByLabel('原作の場面', { exact: true }).selectOption('s');
  await page.getByLabel('開始画像', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('動きの指示', { exact: true }).fill('Camera gently moves forward.');
  await page.getByLabel('動画の寸法', { exact: true }).selectOption('512:512');
  await page.getByRole('button', { name: 'ショットを保存', exact: true }).click();
  const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-project')));
  await page.getByRole('button', { name: '5秒の動画を生成する', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ローカル動画の結果を保存しました' })).toBeVisible();
  let p = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-project')));
  expect(p.videoRevisions).toHaveLength(1);
  expect(p.videoShots[0].adopted_revision).toBeNull();
  expect(p.jobs.at(-1).cost.kind).toBe('local');
  expect(p.history).toEqual(before.history);
  await page.getByRole('button', { name: 'この動画を採用', exact: true }).click();
  await expect(page.getByText(/採用中 ·/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await expect(page.getByLabel('動画の寸法', { exact: true })).toHaveValue('512:512');
  await expect(page.getByLabel('動画の尺', { exact: true })).toHaveValue('5');
  p = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-project')));
  expect(p.videoRevisions).toHaveLength(1);
  expect(p.jobs.filter(j => j.kind === 'video')).toHaveLength(1);
  expect(p.videoShots[0].adopted_revision).toBe(p.videoRevisions[0].id);
});


test('three local batch recipes use the shared runtime sequentially and recover three candidates without cloud calls', async ({ page }) => {
  let initial = await migrateProject(legacy);
  const base = initial.panels[0], artwork = initial.artworks.find(item => item.id === base.artwork_revision);
  initial.panels = Array.from({ length: 3 }, (_, index) => ({ ...structuredClone(base), id: `local-panel-${index}`, artwork_revision: `local-art-${index}` }));
  initial.artworks = initial.panels.map((panel, index) => ({ ...structuredClone(artwork), id: `local-art-${index}`, panel: structuredClone(panel) }));
  initial.jobs = []; initial.history = []; delete initial.layout;
  initial = await upgradeSourceProject(ensureLayout(initial));
  initial = createPanelVideoShots(initial, initial.panels.map((panel, index) => ({ panelId: panel.id, prompt: `Local motion ${index}` })), { batchId: 'local-three', duration: 5, ratio: '512:512' }).project;
  initial.mediaDefaults = { ...initial.mediaDefaults, video: 'ltx-2-5-mlx-local' };
  await page.addInitScript(initial => {
    let running = false;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'acceptance_context') return null;
      const load = () => JSON.parse(sessionStorage.getItem('local-batch') || JSON.stringify(initial));
      if (command === 'source_library') return { active: 'primary', entries: [{ id: 'primary', name: 'Fixture', repo: 'example/story', episode: 'P01' }] };
      if (command === 'load_project') return JSON.stringify(load());
      if (command === 'save_project') { sessionStorage.setItem('local-batch', args.data); return; }
      if (command === 'register_local_video') return 'local-batch-connection';
      if (command === 'remove_local_video') return;
      if (command === 'local_video_submit') {
        if (running) throw Error('Overlapping local execution');
        running = true;
        try {
          const project = load(), job = project.jobs.find(item => item.id === args.jobId);
          if (!job || job.remote || job.manifest.connection.provider !== 'ltx-mlx' || job.manifest.billing.credits !== 0) throw Error('Wrong local batch request');
          const calls = JSON.parse(sessionStorage.getItem('local-calls') || '[]');
          if (project.jobs.length !== calls.length + 1) throw Error('Unsent jobs were reserved ahead of their turn');
          if (project.videoRevisions.length !== calls.length) throw Error('Previous candidate was not recovered before next inference');
          calls.push(job.scope.id); sessionStorage.setItem('local-calls', JSON.stringify(calls));
          const hash = String(calls.length).repeat(64);
          job.remote = { provider: 'ltx-mlx', status: 'SUCCEEDED', artifact: { artifact_id: hash, hash, mime: 'video/mp4', size: 1838 } };
          sessionStorage.setItem('local-batch', JSON.stringify(project));
          return job.remote.artifact;
        } finally { running = false; }
      }
      throw Error(`Unexpected IPC including cloud fallback: ${command}`);
    } };
  }, initial);
  await page.goto('/');
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByText('動画API接続', { exact: true }).click();
  await page.getByLabel('LTX実行ファイル', { exact: true }).fill('/fixture/bin/ltx-2-mlx');
  await page.getByLabel('LTXモデルフォルダ', { exact: true }).fill('/fixture/models');
  await page.getByLabel('FFmpeg実行ファイル', { exact: true }).fill('/fixture/bin/ffmpeg');
  await page.getByLabel('ローカルモデルの利用条件を確認し、動画生成を許可する').check();
  await page.getByRole('button', { name: 'ローカル接続を登録する', exact: true }).click();
  await page.getByLabel('件数・モデル・費用を確認し、1件ずつ送信する').check();
  await page.getByRole('button', { name: '保存したレシピをバッチ実行', exact: true }).click();
  await expect(page.getByRole('region', { name: '動画バッチ実行確認' })).toContainText(/未送信\s*0件/);
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('local-batch')));
  expect(saved.videoRevisions).toHaveLength(3);
  expect(saved.jobs).toHaveLength(3);
  expect(saved.jobs.every(job => job.status === 'candidate' && job.cost.kind === 'local')).toBe(true);
  expect(saved.videoShots.every(shot => shot.adopted_revision === null)).toBe(true);
  expect(saved.panels).toEqual(initial.panels);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('local-calls')))).toEqual(initial.videoShots.map(shot => shot.id));
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await expect(page.getByRole('region', { name: '動画バッチ実行確認' })).toContainText(/未送信\s*0件/);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('local-calls')))).toHaveLength(3);
});
