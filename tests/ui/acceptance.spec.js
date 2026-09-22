import { test, expect } from '@playwright/test';

// IPC fixtures verify the browser workflow. They do not claim native SQLite,
// Apple Silicon inference, real process restart, or visual acceptance passed.
async function nativeFixture(page, { loseResponse = false, contextError = false } = {}) {
  await page.addInitScript(({ loseResponse, contextError }) => {
    const get = (key, fallback = null) => JSON.parse(sessionStorage.getItem(key) ?? JSON.stringify(fallback));
    const put = (key, value) => sessionStorage.setItem(key, JSON.stringify(value));
    const nativeOrder = v => Array.isArray(v) ? v.map(nativeOrder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, nativeOrder(v[k])])) : v;
    const hash = async image => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(image.split(',')[1]), c => c.charCodeAt(0))))].map(n => n.toString(16).padStart(2, '0')).join('');
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      put('acceptance-calls', [...get('acceptance-calls', []), command]);
      if (command === 'acceptance_context') {
        if (contextError) throw Error('isolation unavailable');
        const stages = get('acceptance-stages', {});
        return { sessionId: '17630fa0-98b5-42d9-82a6-3690b37ebf33', resumed: get('acceptance-resumed', false), stages, restartBaseline: stages.adoption?.evidence?.projectSha256 ?? null, report: {} };
      }
      if (command === 'load_project') return sessionStorage.getItem('acceptance-project');
      if (command === 'save_project') { put('acceptance-project', nativeOrder(JSON.parse(args.data))); return; }
      if (command === 'generate_image') {
        const request = args.request;
        put('acceptance-requests', [...get('acceptance-requests', []), request]);
        const canvas = document.createElement('canvas'); canvas.width = request.width; canvas.height = request.height;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111'; ctx.fillRect(50, 50, 100, 100);
        const image = canvas.toDataURL('image/png');
        put('acceptance-receipt', { job_id: request.job.id, input_hash: request.job.input_hash, image, hash: await hash(image), context: request.recovery });
        if (loseResponse) throw Error('injected lost response');
        return image;
      }
      if (command === 'recover_image') return get('acceptance-receipt');
      if (command === 'acceptance_record_stage') {
        const stages = get('acceptance-stages', {}); stages[args.stage] = { status: args.status, evidence: args.evidence }; put('acceptance-stages', stages); return stages[args.stage];
      }
      if (command === 'acceptance_export') {
        const im = new Image(); im.src = args.image; await im.decode();
        return { sha256: await hash(args.image), width: im.width, height: im.height, bytes: atob(args.image.split(',')[1]).length };
      }
      if (command === 'acceptance_finish') return {};
      throw Error(`unexpected IPC in isolated acceptance: ${command}`);
    } };
  }, { loseResponse, contextError });
}

test('dedicated launch waits for explicit run, generates one local image, renders Japanese PNG and resumes without regeneration', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  const run = page.getByRole('button', { name: '最小制作確認を実行', exact: true });
  await expect(run).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acceptance-calls')))).toEqual(['acceptance_context', 'load_project']);
  await expect(page.getByLabel('GitHubリポジトリ')).toHaveCount(0);
  await expect(page.getByTestId('acceptance-visual_review')).toHaveText('NOT_RUN');
  await run.click();
  await expect(page.getByTestId('acceptance-export_png')).toHaveText('PASS');
  await expect(page.getByRole('img', { name: '確認用原稿のPNG' })).toBeVisible();
  const result = await page.evaluate(() => ({ requests: JSON.parse(sessionStorage.getItem('acceptance-requests')), p: JSON.parse(sessionStorage.getItem('acceptance-project')), stages: JSON.parse(sessionStorage.getItem('acceptance-stages')) }));
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({ width: 256, height: 256, steps: 4, media: { registry_id: 'flux-2-klein-4b-q6-local' } });
  expect(result.p.jobs.find(job => job.kind === 'generate').status).toBe('complete');
  expect(result.p.sourceApplication.units).toHaveLength(1);
  expect(result.p.sourceApplication.units[0].requiredText).toHaveLength(2);
  expect(result.p.namePlan.productionState).toBe('proof-ready');
  expect(result.stages.export_png.evidence).toMatchObject({ width: 1600, height: 2260 });
  await expect(page.getByTestId('acceptance-restart')).toHaveText('NOT_RUN');
  await expect(page.getByTestId('acceptance-p01_review')).toHaveText('NOT_RUN');
  await expect(page.getByTestId('acceptance-name_v2_compiler')).toHaveText('PASS');
  await page.evaluate(() => sessionStorage.setItem('acceptance-resumed', 'true'));
  await page.reload();
  const restart = page.getByRole('button', { name: '再起動後の保存内容を確認' });
  await expect(restart).toBeEnabled();
  await restart.click();
  await expect(page.getByTestId('acceptance-restart')).toHaveText('PASS');
  await run.click();
  await expect(run).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acceptance-requests')).length)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acceptance-calls')).some(c => ['github_file', 'source_library', 'prepare_media_engine', 'llm_config', 'backup_state'].includes(c)))).toBe(false);
});

test('lost response survives reload and saved receipt is explicitly recovered with no new generation', async ({ page }) => {
  await nativeFixture(page, { loseResponse: true });
  await page.goto('/');
  const run = page.getByRole('button', { name: '最小制作確認を実行', exact: true });
  await run.click();
  await expect(page.getByRole('alert')).toContainText('injected lost response');
  await expect(page.getByTestId('acceptance-generation')).toHaveText('FAIL');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acceptance-project')).jobs.find(job => job.kind === 'generate').status)).toBe('unknown');
  await page.evaluate(() => sessionStorage.setItem('acceptance-resumed', 'true'));
  await page.reload();
  await expect(run).toBeDisabled();
  const recover = page.getByRole('button', { name: '保存済み結果を回収', exact: true });
  await expect(recover).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acceptance-requests')).length)).toBe(1);
  await recover.click();
  await expect(page.getByTestId('acceptance-export_png')).toHaveText('PASS');
  await expect(page.getByTestId('acceptance-generation')).toHaveText('PASS');
  await expect(page.getByRole('button', { name: '再起動後の保存内容を確認' })).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acceptance-project')).jobs.find(job => job.kind === 'generate').status)).toBe('complete');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acceptance-requests')).length)).toBe(1);
});

test('native isolation failure never mounts the ordinary app or loads a project', async ({ page }) => {
  await nativeFixture(page, { contextError: true });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('isolation unavailable');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acceptance-calls')))).toEqual(['acceptance_context']);
  await expect(page.getByRole('button')).toHaveCount(0);
});
