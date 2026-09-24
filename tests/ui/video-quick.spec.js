import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('a configured panel submits its image and source without opening the video screen or entering motion', async ({ page }) => {
  await page.addInitScript(project => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'acceptance_context') return null;
      const load = () => JSON.parse(sessionStorage.getItem('video-quick-project') || JSON.stringify(project));
      if (command === 'load_project') return JSON.stringify(load());
      if (command === 'save_project') { sessionStorage.setItem('video-quick-project', args.data); return; }
      if (command === 'source_library') return { active: 'primary', entries: [{ id: 'primary', name: 'Fixture', repo: 'example/story', episode: 'P01' }] };
      if (command === 'register_video') return 'quick-connection';
      if (command === 'video_submit') {
        const saved = load(), job = saved.jobs.find(item => item.id === args.jobId);
        if (!job || job.remote || job.manifest.connection.id !== 'quick-connection') throw Error('Submitted without a saved job or connection');
        const calls = JSON.parse(sessionStorage.getItem('video-quick-calls') || '[]');
        calls.push({ shotId: job.scope.id, hash: job.manifest.providerInputs[0].hash, source: job.manifest.source });
        sessionStorage.setItem('video-quick-calls', JSON.stringify(calls));
        job.remote = { status: 'PENDING', task_id: `task-${job.id}`, reserved_credits: job.manifest.billing.credits };
        sessionStorage.setItem('video-quick-project', JSON.stringify(saved));
        return;
      }
      throw Error(`Unexpected IPC: ${command}`);
    } };
  }, fixture);
  await page.goto('/');
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByText('動画生成の設定', { exact: true }).click();
  await page.getByLabel('Runway APIキー', { exact: true }).fill('fixture-key');
  await page.getByLabel('この送信先・モデル・送信内容・予算内での生成を許可する').check();
  await page.getByRole('button', { name: '接続を登録する', exact: true }).click();
  await page.getByRole('button', { name: '漫画', exact: true }).click();
  await page.getByRole('button', { name: '1コマ目を選択' }).click();
  await page.getByRole('region', { name: 'コマの動画' }).getByRole('button', { name: 'このコマから動画を生成' }).click();
  await expect(page.getByRole('button', { name: '漫画', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'コマの動画' })).toContainText('サービスで処理中');
  const calls = await page.evaluate(() => JSON.parse(sessionStorage.getItem('video-quick-calls') || '[]'));
  expect(calls).toHaveLength(1);
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('video-quick-project')));
  expect(saved.videoShots[0].prompt).toContain('Preserve the exact composition');
  expect(saved.videoShots[0].unitIds).toEqual(fixture.panels[0].unitIds);
  expect(calls[0].hash).toBe(saved.videoShots[0].startImage.hash);
});
