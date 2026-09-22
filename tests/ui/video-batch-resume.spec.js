import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { migrateProject } from '../../src/revisions.js';
import { ensureLayout } from '../../src/layout.js';
import { upgradeSourceProject } from '../../src/source-application.js';
import { createPanelVideoShots } from '../../src/video-batch.js';

const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));
const batchApproval = '件数・モデル・費用を確認し、1件ずつ送信する';

async function savedBatch() {
  let project = await migrateProject(legacy);
  const base = project.panels[0], artwork = project.artworks.find(item => item.id === base.artwork_revision);
  project.panels = Array.from({ length: 3 }, (_, index) => ({
    ...structuredClone(base), id: `s:p${index}`, artwork_revision: `batch-art-${index}`,
  }));
  project.artworks = project.panels.map((panel, index) => ({
    ...structuredClone(artwork), id: `batch-art-${index}`, panel: structuredClone(panel),
  }));
  project.jobs = []; project.history = [];
  delete project.layout;
  project = await upgradeSourceProject(ensureLayout(project));
  return createPanelVideoShots(project, project.panels.map((panel, index) => ({
    panelId: panel.id, prompt: `保存した動き ${index + 1}`,
  })), { batchId: 'saved-three-panel-batch', duration: 5, ratio: '960:960' }).project;
}

// IPC is deliberately local: this exercises persisted job/recipe recovery and
// UI sequencing, without claiming a paid Runway or Mac runtime acceptance.
async function openBatch(page, mode = 'success') {
  const initial = await savedBatch();
  await page.addInitScript(({ initial, mode }) => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'acceptance_context') return null;
      const load = () => JSON.parse(sessionStorage.getItem('batch-project') || JSON.stringify(initial));
      if (command === 'load_project') return JSON.stringify(load());
      if (command === 'save_project') { sessionStorage.setItem('batch-project', args.data); return; }
      if (command === 'source_library') return { active: 'primary', entries: [{ id: 'primary', name: 'Fixture', repo: 'example/story', episode: 'P01' }] };
      if (command === 'register_video') return `fixture-${args.input.model}`;
      if (command === 'remove_video') return;
      if (command === 'video_submit') {
        const project = load(), job = project.jobs.find(item => item.id === args.jobId);
        if (!job || job.remote) throw Error('Fixture refuses a missing or already submitted job');
        const calls = JSON.parse(sessionStorage.getItem('batch-submissions') || '[]');
        calls.push({ jobId: job.id, shotId: job.scope.id, model: job.manifest.connection.model });
        sessionStorage.setItem('batch-submissions', JSON.stringify(calls));
        if (mode === 'hold-first' && calls.length === 1) {
          await new Promise(resolve => { window.finishVideoSubmission = resolve; });
        }
        job.remote = { status: 'PENDING', task_id: `task-${job.id}`, reserved_credits: job.manifest.billing.credits };
        if (mode === 'lost-second-response' && calls.length === 2) {
          job.remote = { status: 'unknown', reserved_credits: job.manifest.billing.credits };
          sessionStorage.setItem('batch-project', JSON.stringify(project));
          throw Error('動画送信の応答が失われました（fixture）');
        }
        sessionStorage.setItem('batch-project', JSON.stringify(project));
        return;
      }
      throw Error(`Unexpected fixture IPC: ${command}`);
    } };
  }, { initial, mode });
  await page.goto('/');
  await showVideo(page);
  await expect(page.getByLabel('保存済み動画バッチ', { exact: true })).toHaveValue('saved-three-panel-batch');
  await expect(page.getByRole('region', { name: '動画バッチ実行確認' })).toContainText(/未送信\s*3件/);
  return initial;
}

async function showVideo(page) {
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await expect(page.getByRole('heading', { name: '動画ショット', exact: true })).toBeVisible();
}

async function registerConnection(page) {
  await page.getByText('動画API接続', { exact: true }).click();
  await page.getByLabel('Runway APIキー', { exact: true }).fill('fixture-only-key');
  await page.getByLabel('この送信先・モデル・送信内容・予算内での生成を許可する').check();
  await page.getByRole('button', { name: '接続を登録する', exact: true }).click();
  await expect(page.getByRole('button', { name: '接続を解除する', exact: true })).toBeVisible();
}

const submissions = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('batch-submissions') || '[]'));
const executeButton = page => page.getByRole('button', { name: '保存したレシピをバッチ実行', exact: true });

test('saved batch survives restart and resumes only unattempted shots after a lost submit response', async ({ page }) => {
  const initial = await openBatch(page, 'lost-second-response');
  await page.reload();
  await showVideo(page);
  await expect(page.getByLabel('保存済み動画バッチ', { exact: true })).toHaveValue('saved-three-panel-batch');
  expect(await submissions(page)).toEqual([]);
  await registerConnection(page);
  await page.getByLabel(batchApproval).check();
  await executeButton(page).click();
  await expect(page.getByRole('alert')).toContainText('動画送信の応答が失われました');
  expect((await submissions(page)).map(call => call.shotId)).toEqual(initial.videoShots.slice(0, 2).map(shot => shot.id));

  await page.reload();
  await showVideo(page);
  await expect(page.getByRole('region', { name: '動画バッチ実行確認' })).toContainText(/未送信\s*1件/);
  await expect(page.getByLabel(batchApproval)).not.toBeChecked();
  await registerConnection(page);
  await page.getByLabel(batchApproval).check();
  await executeButton(page).click();
  await expect(page.getByRole('region', { name: '動画バッチ実行確認' })).toContainText(/未送信\s*0件/);
  expect((await submissions(page)).map(call => call.shotId)).toEqual(initial.videoShots.map(shot => shot.id));
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('batch-project')));
  expect(saved.jobs.filter(job => job.scope?.type === 'videoShot')).toHaveLength(3);
  expect(saved.jobs.find(job => job.scope?.id === initial.videoShots[1].id).remote.status).toBe('unknown');
  expect(saved.videoShots.map(shot => shot.prompt)).toEqual(initial.videoShots.map(shot => shot.prompt));
  expect(saved.videoShots.every(shot => shot.adopted_revision === null)).toBe(true);
});

test('stop remains usable during submission and resumes the remaining shots without overlapping requests', async ({ page }) => {
  const initial = await openBatch(page, 'hold-first');
  await registerConnection(page);
  await page.getByLabel(batchApproval).check();
  await executeButton(page).click();
  await expect.poll(async () => (await submissions(page)).length).toBe(1);
  const stop = page.getByRole('button', { name: '次のコマから停止', exact: true });
  await expect(stop).toBeEnabled();
  await stop.click();
  expect((await submissions(page)).map(call => call.shotId)).toEqual([initial.videoShots[0].id]);
  await page.evaluate(() => window.finishVideoSubmission());
  await expect(page.getByRole('region', { name: '動画バッチ実行確認' })).toContainText(/未送信\s*2件/);
  await expect(page.getByLabel(batchApproval)).not.toBeChecked();
  expect(await submissions(page)).toHaveLength(1);
  await page.getByLabel(batchApproval).check();
  await executeButton(page).click();
  await expect(page.getByRole('region', { name: '動画バッチ実行確認' })).toContainText(/未送信\s*0件/);
  expect((await submissions(page)).map(call => call.shotId)).toEqual(initial.videoShots.map(shot => shot.id));
});

test('model and saved recipe cost changes require fresh batch approval', async ({ page }) => {
  await openBatch(page);
  await registerConnection(page);
  await page.getByLabel(batchApproval).check();
  await page.getByLabel('動画の生成先', { exact: true }).selectOption('runway-gen4-turbo');
  await expect(page.getByLabel(batchApproval)).not.toBeChecked();
  await expect(executeButton(page)).toBeDisabled();

  await page.getByLabel('動画の生成先', { exact: true }).selectOption('runway-gen4-5');
  await page.getByLabel(batchApproval).check();
  await page.getByRole('navigation', { name: '動画ショット一覧' }).getByRole('button').first().click();
  await page.getByLabel('このショットの尺', { exact: true }).selectOption('10');
  await expect(executeButton(page)).toBeDisabled();
  await expect(page.getByRole('region', { name: '動画バッチ実行確認' })).toContainText('このバッチに含まれるショットの変更を保存してください。');
  expect(await submissions(page)).toEqual([]);
  await page.getByRole('button', { name: '指示を保存する', exact: true }).click();
  await expect(page.getByLabel(batchApproval)).not.toBeChecked();
  await expect(executeButton(page)).toBeDisabled();
  expect(await submissions(page)).toEqual([]);
});
