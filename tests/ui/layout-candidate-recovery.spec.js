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
  await page.getByText('演出AIでこのページを配置', { exact: true }).click();
}

test('three saved attempts reopen without a connection, render the target only, and discard stays discarded', async ({ page }) => {
  await seed(page);
  const picker = page.getByLabel('保存したコマ割り候補', { exact: true });
  await expect(picker).toHaveValue('saved-0');
  await expect(page.getByRole('img', { name: /AIコマ割り候補/ })).toHaveCount(1);
  await page.locator('.thumbnail').nth(1).click();
  await expect(picker).toHaveValue('saved-2');
  await picker.selectOption('saved-1');
  await expect(page.getByText('変更対象: 2ページ。本文・作画・人物は保持。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '候補を破棄', exact: true }).click();
  await expect(picker.locator('option[value="saved-1"]')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'コマ割り編集', exact: true }).click();
  await page.locator('.thumbnail').nth(1).click();
  await page.getByText('演出AIでこのページを配置', { exact: true }).click();
  await expect(picker).toHaveValue('saved-2');
  await expect(picker.locator('option[value="saved-1"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await expect(page.locator('.thumbnail').nth(1)).toHaveAttribute('aria-current', 'page');
  const saved = await page.evaluate(async () => (await import('/src/bridge.js')).loadProject());
  expect(saved.jobs.map(job => job.status)).toEqual(['candidate', 'abandoned', 'complete']);
  expect(saved.panels.every(panel => panel.image === legacy.panels[0].image)).toBe(true);
});

test('a saved proposal cannot overwrite layout edited after its creation', async ({ page }) => {
  await seed(page, { stale: true });
  await page.locator('.thumbnail').nth(1).click();
  await expect(page.getByRole('button', { name: 'このコマ割りを採用', exact: true })).toBeDisabled();
  await expect(page.getByText(/作品が変更されたため、この候補は採用できません/)).toBeVisible();
  await expect(page.getByRole('img', { name: /AIコマ割り候補/ })).toHaveCount(0);
  const before = await page.evaluate(async () => (await (await import('/src/bridge.js')).loadProject()).layout);
  await page.getByRole('button', { name: '候補を破棄', exact: true }).click();
  const after = await page.evaluate(async () => (await (await import('/src/bridge.js')).loadProject()).layout);
  expect(after).toEqual(before);
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
  await page.getByText('演出AIでこのページを配置', { exact: true }).click();
  await page.getByLabel('保存したコマ割り候補', { exact: true }).selectOption('broken');
  await expect(page.getByRole('alert')).toContainText('対象ページを確認できません');
  await expect(page.getByRole('button', { name: 'このコマ割りを採用', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '候補を破棄', exact: true }).click();
  await expect(page.getByLabel('保存したコマ割り候補').locator('option[value="broken"]')).toHaveCount(0);
  await expect(page.getByTestId('layout-slot-0')).toBeVisible();
});
