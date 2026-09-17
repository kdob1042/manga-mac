import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));
test('LEGACY-01 reload, Undo images, and byte-identical PNG/CBZ page content', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async legacy => {
    const { migrateProject } = await import('/src/revisions.js');
    const {pagePNG}=await import('/src/render.js');const {exportCBZ}=await import('/src/export.js');
    const { saveProject } = await import('/src/bridge.js');
    const project = await migrateProject(legacy);
    const before = await pagePNG(legacy.panels, legacy.snapshots);
    const after = await pagePNG(project.panels, project.snapshots);
    const undo = await pagePNG(project.history[0].panels, project.snapshots);
    const cbz = await exportCBZ(project);
    const originalZip = await exportCBZ(legacy);
    await saveProject(project);
    return { samePNG: before === after, sameUndo: undo === await pagePNG(legacy.history[0].panels, legacy.snapshots), undoDiffers: undo !== before, cbz: Array.from(new Uint8Array(await cbz.arrayBuffer())), originalZip: Array.from(new Uint8Array(await originalZip.arrayBuffer())) };
  }, fixture);
  expect(result.samePNG).toBe(true);
  expect(result.sameUndo).toBe(true);
  expect(result.undoDiffers).toBe(true);
  const beforeZip = await JSZip.loadAsync(result.originalZip), afterZip = await JSZip.loadAsync(result.cbz);
  expect(Object.keys(afterZip.files)).toEqual(Object.keys(beforeZip.files));
  for (const name of Object.keys(beforeZip.files).filter(n => n.endsWith('.png'))) expect(await afterZip.file(name).async('uint8array')).toEqual(await beforeZip.file(name).async('uint8array'));
  const provenance = JSON.parse(await afterZip.file('provenance.json').async('string'));
  expect(provenance.sources[0].sha).toBe(fixture.snapshots[0].sha);
  expect(provenance.panels[0].unitIds).toEqual(fixture.panels[0].unitIds);
  await page.reload();
  await expect(page.locator('.caption')).toContainText('「原文です」');
  await expect(page.locator('.art img')).toHaveAttribute('src', fixture.panels[0].image);
  await page.getByRole('button', { name: '元に戻す' }).click();
  // commit updates the visible image only after saveProject has completed.
  await expect(page.locator('.art img')).toHaveAttribute('src', fixture.history[0].panels[0].image);
  await page.reload();
  await expect(page.locator('.art img')).toHaveAttribute('src', fixture.history[0].panels[0].image);
  await page.screenshot({ path: 'test-results/legacy-migrated.png', fullPage: true });
});
