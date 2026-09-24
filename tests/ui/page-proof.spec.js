import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('page thumbnails use saved asymmetric geometry rather than equal two-column cells', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async fixture => {
    const {saveProject} = await import('/src/bridge.js');
    const {initialLayout} = await import('/src/layout.js');
    fixture.panels = Array.from({length: 3}, (_, i) => ({...fixture.panels[0], id: `thumbnail-${i}`, image: null}));
    fixture.layout = initialLayout(fixture.panels);
    fixture.layout.pages[0].slots.forEach((slot, i) => {
      slot.points = [
        [[.04,.03],[.96,.03],[.96,.40],[.04,.40]],
        [[.51,.43],[.96,.43],[.96,.96],[.51,.96]],
        [[.04,.43],[.49,.43],[.49,.96],[.04,.96]],
      ][i];
    });
    await saveProject(fixture);
  }, legacy);
  await page.reload();
  const panels = page.locator('.thumbnail').first().locator('.mini-page-panel');
  await expect(panels).toHaveCount(3);
  const top = await panels.nth(0).boundingBox();
  const bottom = await panels.nth(1).boundingBox();
  expect(top.width).toBeGreaterThan(bottom.width * 1.9);
  expect(top.height).toBeLessThan(bottom.height);
});

test('adding a page does not leave another page panel selected for finishing', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async fixture => { await (await import('/src/bridge.js')).saveProject(fixture); }, legacy);
  await page.reload();
  await page.getByRole('button', { name: '1コマ目を選択', exact: true }).click();
  await page.getByRole('button', { name: 'コマ割り編集', exact: true }).click();
  await page.getByRole('button', { name: 'ページ追加', exact: true }).click();
  await expect(page.locator('.thumbnail').nth(1)).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: '仕上げ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'コマの仕上げ', exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: '書き出しページの確認' })).toHaveCount(0);
});

test('failed and empty pages never retain another page proof; preview errors clear with the page', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async fixture => {
    const { saveProject } = await import('/src/bridge.js');
    const { initialLayout } = await import('/src/layout.js');
    fixture.snapshots[0].scenes.push({ ...fixture.snapshots[0].scenes[0], id: 't' });
    fixture.panels = Array.from({ length: 5 }, (_, i) => ({ ...fixture.panels[0], id: `panel${i}`,
      ...(i === 4 ? { sceneId: 't', unitIds: ['t:u0', 't:u1'], image: null } : {}) }));
    fixture.jobs = []; fixture.history = [];
    fixture.layout = initialLayout(fixture.panels);
    fixture.layout.pages.push({ id: 'empty-page', slots: [] });
    await saveProject(fixture);
  }, legacy);
  await page.reload();
  await page.getByRole('button', { name: '仕上げ', exact: true }).click();
  const proof = page.getByRole('img', { name: '書き出しページの確認' });
  await expect(proof).toBeVisible();
  const section = page.getByRole('region', { name: 'セクションの完了管理' }).getByRole('combobox');
  // This navigation does not go through the page-thumbnail handler.
  await section.selectOption('t');
  await expect(page.getByRole('alert')).toContainText('未作画のコマ');
  await expect(proof).toHaveCount(0);
  await section.selectOption('s');
  await expect(proof).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('.thumbnail').nth(2).click();
  await expect(proof).toHaveCount(0);
  await expect(page.getByText('このページにはコマがありません。コマ割り編集で配置してください。', { exact: true })).toBeVisible();
});

test('a delayed old proof cannot replace the newly selected page', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async fixture => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = ReactDOM;
    const { default: PageProof } = await import('/src/PageProof.jsx');
    const { initialLayout } = await import('/src/layout.js');
    const { emptyProject } = await import('/src/core.js');
    const { pagePNG } = await import('/src/render.js');
    const project = { ...emptyProject(), ...fixture };
    const first = { ...project.panels[0], id: 'first' };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.fillStyle = '#0000ff'; context.fillRect(0, 0, 1, 1);
    const second = { ...first, id: 'second', image: canvas.toDataURL() };
    const pg = initialLayout([first]).pages[0];
    const next = { ...pg, id: 'next', slots: pg.slots.map(s => ({ ...s, panelId: second.id })) };
    const expected = await pagePNG([second], project.snapshots, [], 'ja', next);
    const host = document.createElement('div'); host.id = 'proof-race'; document.body.append(host);
    const root = createRoot(host), RealImage = window.Image;
    const releases = [];
    window.Image = function (...args) {
      const image = new RealImage(...args);
      let handler;
      Object.defineProperty(image, 'onload', { set(fn) {
        handler = event => image.src === first.image ? releases.push(() => fn(event)) : fn(event);
        image.addEventListener('load', handler, { once: true });
      } });
      return image;
    };
    const props = { snapshots: project.snapshots, localizations: [], locale: 'ja', imageCrops: {} };
    root.render(React.createElement(PageProof, { ...props, panels: [first], page: pg }));
    for (let i = 0; i < 100 && !releases.length; i++) await new Promise(r => setTimeout(r, 10));
    if (!releases.length) throw Error('The first render did not reach image loading');
    root.render(React.createElement(PageProof, { ...props, panels: [second], page: next }));
    for (let i = 0; i < 100 && !host.querySelector('img'); i++) await new Promise(r => setTimeout(r, 10));
    const before = host.querySelector('img')?.src;
    releases.forEach(release => release());
    await new Promise(r => setTimeout(r, 100));
    const after = host.querySelector('img')?.src;
    root.unmount(); host.remove(); window.Image = RealImage;
    return { before, after, expected };
  }, legacy);
  expect(result.before).toBe(result.expected);
  expect(result.after).toBe(result.expected);
});
