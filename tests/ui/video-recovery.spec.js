import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('lost cancel acknowledgement can be resolved locally only after service confirmation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async legacy => {
    const project = { ...legacy, version: 4, jobs: [{ id: 'lost', scope: { type: 'videoShot', id: 'v' }, status: 'cancel_requested', remote: { status: 'cancel_requested', task_id: 'task', reserved_credits: 60 } }], videoShots: [{ id: 'v', snapshotId: legacy.active, sceneId: 's', unitIds: ['s:u0'], characterIds: ['a'], startImage: { kind: 'artwork', id: 'unused', hash: 'a'.repeat(64) }, prompt: 'Stay still', ratio: '960:960', duration: 5, adopted_revision: null }] };
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('manga-mac', 1);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('data', 'readwrite'); tx.objectStore('data').put(project, 'project'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
  }, legacy);
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByRole('button', { name: '1 · s', exact: true }).click();
  await page.getByText('要求・取得を手動で解決する', { exact: true }).click();
  const resolve = page.getByRole('button', { name: '採用せずローカルで解決する', exact: true });
  await expect(resolve).toBeDisabled();
  await page.getByLabel('サービス側を確認し、この結果を採用しないことを確認しました').check();
  await resolve.click();
  await expect(page.getByText('採用せず解決済み · 予約 60 credits', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByRole('button', { name: '1 · s', exact: true }).click();
  await expect(page.getByText('採用せず解決済み · 予約 60 credits', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '採用せずローカルで解決する', exact: true })).toHaveCount(0);
});
