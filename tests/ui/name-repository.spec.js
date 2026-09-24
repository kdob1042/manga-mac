import { test, expect } from '@playwright/test';

async function setup(page) {
  // Native transport and persistence are fixtures. The app UI and name pipeline are real.
  await page.addInitScript(() => {
    window.repositoryCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'acceptance_context') return null;
      if (command === 'source_library') return { active: 'primary', entries: [{ id: 'primary', name: 'ネーム試験', repo: 'fixture/stories', episode: 'P01', work_id: 'example' }] };
      if (command === 'load_project') return localStorage.getItem('repository-project');
      if (command === 'save_project') { localStorage.setItem('repository-project', args.data); return; }
      if (command === 'backup_status') return { config: null, status: { last_success: 0 }, restored: [], active: 'primary' };
      if (command === 'live_preview_list') return [];
      if (command === 'github_file') {
        window.repositoryCalls.push({ ...args });
        if (args.repo !== 'fixture/stories' || args.sha !== 'a'.repeat(40) || args.path !== 'works/example/manga/P01/name-plan.json') throw Error('unpinned name read');
        return localStorage.getItem('repository-name-file');
      }
      throw Error('Unexpected native call: ' + command);
    } };
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { emptyProject } = await import('/src/core.js');
    const { fileFixture } = await import('/tests/name-plan-fixture.mjs');
    const f = await fileFixture(2, '# Scene\n\n彼は手を振る。\n\n「また明日」');
    f.snapshot.episodeId = 'P01'; f.snapshot.episodeIds = ['P01'];
    f.snapshot.library = { root: 'works/example' };
    delete f.file.source.commit;
    await (await import('/src/bridge.js')).saveProject({ ...emptyProject(), ...f.project, title: 'GitHubネーム受渡し' });
    localStorage.setItem('repository-name-file', JSON.stringify(f.file));
  });
  await page.reload();
  await page.getByText('制作する場面・ネーム・保存した原稿', { exact: true }).click();
}

test('repository button stages the real name candidate and only explicit adoption changes panels', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '同じGitHub版のネームを読み込む', exact: true }).click();
  await expect(page.getByRole('button', { name: 'このネーム候補を採用', exact: true })).toBeVisible();
  const staged = await page.evaluate(() => JSON.parse(localStorage.getItem('repository-project')));
  expect(staged.panels).toEqual([]);
  const job = staged.jobs.find(j => j.nameCandidate);
  expect(job.repositoryPlan).toEqual({ repo: 'fixture/stories', commit: 'a'.repeat(40), path: 'works/example/manga/P01/name-plan.json', episodeId: 'P01' });
  await page.getByRole('button', { name: 'このネーム候補を採用', exact: true }).click();
  await expect(page.getByRole('button', { name: 'このネームで制作', exact: true })).toBeVisible();
  const adopted = await page.evaluate(() => JSON.parse(localStorage.getItem('repository-project')));
  expect(adopted.panels).toHaveLength(2);
  expect(adopted.panels.every(p => p.image === null)).toBe(true);
  expect(adopted.namePlan.file.source.commit).toBeUndefined();
  expect(adopted.jobs.some(j => ['generate', 'retake', 'video'].includes(j.kind))).toBe(false);
  expect(await page.evaluate(() => window.repositoryCalls.length)).toBe(1);
  await page.reload();
  await page.getByText('制作する場面・ネーム・保存した原稿', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'このネームで制作', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.repositoryCalls)).toEqual([]);
});

test('wrong-work repository response never creates a candidate or modifies the saved project', async ({ page }) => {
  await setup(page);
  const before = await page.evaluate(() => {
    const file = JSON.parse(localStorage.getItem('repository-name-file')); file.source.workId = 'other';
    localStorage.setItem('repository-name-file', JSON.stringify(file));
    return localStorage.getItem('repository-project');
  });
  await page.getByRole('button', { name: '同じGitHub版のネームを読み込む', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('別作品');
  expect(await page.evaluate(() => localStorage.getItem('repository-project'))).toBe(before);
  expect(await page.evaluate(() => window.repositoryCalls.length)).toBe(1);
});
