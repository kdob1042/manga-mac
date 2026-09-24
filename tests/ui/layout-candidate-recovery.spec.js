import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

async function seed(page, { stale = false } = {}) {
  await page.goto('/');
  await page.evaluate(async ({ fixture, stale }) => {
    const { saveProject } = await import('/src/bridge.js');
    const { validateProposal, layoutBase } = await import('/src/layout-ai.js');
    fixture.panels = Array.from({ length: 8 }, (_, i) => ({ ...fixture.panels[0], id: `p${i}` }));
    fixture.history = []; fixture.jobs = [];
    const project = await saveProject(fixture);
    project.jobs = [0, 1, 1].map((index, i) => {
      const page = structuredClone(project.layout.pages[index]);
      page.slots[0].points[0][0] += .01 * (i + 1);
      const id = `saved-${i}`;
      return { id, kind: 'layout', status: 'candidate', input_hash: layoutBase(project), layout_candidate: { ...validateProposal(project, { reason: `保存案${i + 1}`, pages: [page] }, [page.id]), jobId: id } };
    });
    if (stale) project.layout.pages[1].slots[0].points[0][0] += .04;
    await saveProject(project);
  }, { fixture: legacy, stale });
  await page.reload();
  await page.getByRole('button', { name: 'コマ割り編集', exact: true }).click();
}

async function geometry(page) {
  return page.evaluate(async () => {
    const project = await (await import('/src/bridge.js')).loadProject();
    const points = slot => slot.points.map(([x, y]) => `${x * 1600},${y * 2260}`).join(' ');
    return {
      adopted: project.layout.pages.map(p => points(p.slots[0])),
      candidates: Object.fromEntries(project.jobs.filter(j => j.layout_candidate?.layout?.pages).map(j =>
        [j.id, j.layout_candidate.layout.pages.map(p => points(p.slots[0]))]
      )),
    };
  });
}

test('saved attempts reopen without a connection, rejection restores editor and persists', async ({ page }) => {
  await seed(page);
  const expected = await geometry(page);
  const picker = page.getByLabel('保存したコマ割り候補', { exact: true });
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('img', { name: /AIコマ割り候補/ })).toHaveCount(1);
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.candidates['saved-0'][0]);
  expect(expected.adopted[0]).not.toBe(expected.candidates['saved-0'][0]);
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.adopted[0]);
  await page.locator('.thumbnail').nth(1).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.candidates['saved-2'][1]);
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  await expect(picker).toHaveValue('');
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.adopted[1]);
  await page.getByTestId('layout-slot-0').click({ position: { x: 60, y: 45 } });
  await expect(page.getByTestId('vertex-0')).toBeVisible();
  await picker.selectOption('saved-1');
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.candidates['saved-1'][1]);
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  await expect(picker.locator('option[value="saved-1"]')).toHaveCount(0);
  await expect(picker).toHaveValue('');
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.adopted[1]);
  expect((await geometry(page)).adopted).toEqual(expected.adopted);
  await page.reload();
  await page.getByRole('button', { name: 'コマ割り編集', exact: true }).click();
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.adopted[0]);
  await expect(page.getByRole('button', { name: '採用して編集', exact: true })).toHaveCount(0);
  await expect(picker.locator('option[value="saved-1"]')).toHaveCount(0);
  await page.getByTestId('layout-slot-0').click({ position: { x: 60, y: 45 } });
  await expect(page.getByTestId('vertex-0')).toBeVisible();
  await expect(page.locator('.thumbnail').first()).toHaveAttribute('aria-current', 'page');
  const saved = await page.evaluate(async () => (await import('/src/bridge.js')).loadProject());
  expect(saved.jobs.map(job => job.status)).toEqual(['abandoned', 'abandoned', 'abandoned']);
  expect(saved.panels.every(panel => panel.image === legacy.panels[0].image)).toBe(true);
});

test('accepting a saved layout enters manual drag editing and preserves art', async ({ page }) => {
  await seed(page);
  const expected = await geometry(page);
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.candidates['saved-0'][0]);
  expect((await geometry(page)).adopted).toEqual(expected.adopted);
  await page.getByRole('button', { name: '採用して編集', exact: true }).click();
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.candidates['saved-0'][0]);
  await page.getByTestId('layout-slot-0').click({ position: { x: 60, y: 45 } });
  await expect(page.getByTestId('vertex-0')).toBeVisible();
  const saved = await page.evaluate(async () => (await import('/src/bridge.js')).loadProject());
  expect(saved.jobs[0].status).toBe('complete');
  expect(saved.panels.every(panel => panel.image === legacy.panels[0].image)).toBe(true);
});

test('a multi-page proposal previews every proposed page before changing the adopted layout', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const { loadProject, saveProject } = await import('/src/bridge.js');
    const { validateProposal, layoutBase } = await import('/src/layout-ai.js');
    const project = await loadProject();
    const pages = structuredClone(project.layout.pages);
    pages[0].slots[0].points[0][0] += .03;
    pages[1].slots[0].points[0][0] += .04;
    project.jobs.push({ id: 'both-pages', kind: 'layout', status: 'candidate', input_hash: layoutBase(project), layout_candidate: {
      ...validateProposal(project, { reason: '二ページを一緒に配置', pages }, pages.map(p => p.id)), jobId: 'both-pages',
    } });
    await saveProject(project);
  });
  await page.reload();
  await page.getByRole('button', { name: 'コマ割り編集', exact: true }).click();
  const expected = await geometry(page);
  const picker = page.getByLabel('保存したコマ割り候補', { exact: true });
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.candidates['both-pages'][0]);
  await page.getByRole('button', { name: '候補の次ページ', exact: true }).click();
  await expect(page.getByText('候補 2 / 2 ページ')).toBeVisible();
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.candidates['both-pages'][1]);
  await expect(page.locator('.thumbnail').first()).toHaveAttribute('aria-current', 'page');
  expect((await geometry(page)).adopted).toEqual(expected.adopted);
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  await expect(picker).toHaveValue('');
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.adopted[0]);
  await picker.selectOption('saved-0');
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.candidates['saved-0'][0]);
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', expected.adopted[0]);
  expect((await geometry(page)).adopted).toEqual(expected.adopted);
  await page.getByTestId('layout-slot-0').click({ position: { x: 60, y: 45 } });
  await expect(page.getByTestId('vertex-0')).toBeVisible();
});

test('a saved proposal cannot overwrite layout edited after its creation', async ({ page }) => {
  await seed(page, { stale: true });
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  await page.locator('.thumbnail').nth(1).click();
  const before = await geometry(page);
  await expect(page.getByRole('button', { name: '採用して編集', exact: true })).toHaveCount(0);
  await expect(page.getByText(/作品が変更されたため、この案は採用できません/)).toBeVisible();
  await expect(page.getByRole('img', { name: /AIコマ割り候補/ })).toHaveCount(0);
  await expect(page.getByTestId('layout-slot-0')).toHaveAttribute('points', before.adopted[1]);
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  expect((await geometry(page)).adopted).toEqual(before.adopted);
});

test('a damaged saved proposal can be discarded while the layout editor remains usable', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const { loadProject, saveProject } = await import('/src/bridge.js');
    const project = await loadProject();
    project.jobs.push({ id: 'broken', kind: 'layout', status: 'candidate', layout_candidate: { base: '{', scope: null } });
    await saveProject(project);
  });
  await page.reload();
  await page.getByRole('button', { name: 'コマ割り編集', exact: true }).click();
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  await page.getByLabel('保存したコマ割り候補', { exact: true }).selectOption('broken');
  await expect(page.getByRole('alert')).toContainText('対象ページを確認できません');
  await expect(page.getByRole('button', { name: '採用して編集', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '採用せず編集', exact: true }).click();
  await expect(page.getByLabel('保存したコマ割り候補').locator('option[value="broken"]')).toHaveCount(0);
  await expect(page.getByTestId('layout-slot-0')).toBeVisible();
});
