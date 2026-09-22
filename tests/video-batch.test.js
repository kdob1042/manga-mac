import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrateProject } from '../src/revisions.js';
import { beginVideoJob } from '../src/video.js';
import { createPanelVideoShots, panelVideoRecipes } from '../src/video-batch.js';

const legacy = JSON.parse(await readFile(new URL('./fixtures/legacy-v1.json', import.meta.url)));

async function fixture(count = 3) {
  const project = await migrateProject(legacy);
  const base = project.panels[0], artwork = project.artworks.find(item => item.id === base.artwork_revision);
  project.panels = Array.from({ length: count }, (_, index) => ({ ...structuredClone(base), id: `panel-${index}`, image: artwork.panel.image }));
  project.artworks = project.panels.map((panel, index) => ({ ...structuredClone(artwork), id: `art-${index}`, panel: { ...structuredClone(panel) }, hash: artwork.hash }));
  project.panels.forEach((panel, index) => { panel.artwork_revision = `art-${index}`; });
  return project;
}

test('selected panels create independent persisted video recipes with shared batch identity', async () => {
  const project = await fixture();
  const rows = project.panels.map((panel, index) => ({ panelId: panel.id, prompt: `motion ${index}`, enabled: true }));
  const created = createPanelVideoShots(project, rows, { batchId: 'batch-one', duration: 6, ratio: '960:960' });
  assert.equal(created.shotIds.length, 3);
  assert.equal(project.videoShots.length, 0);
  assert.deepEqual(created.project.videoShots.map(shot => shot.sourcePanelId), project.panels.map(panel => panel.id));
  assert.deepEqual(created.project.videoShots.map(shot => shot.prompt), ['motion 0', 'motion 1', 'motion 2']);
  assert.ok(created.project.videoShots.every(shot => shot.batchId === 'batch-one' && shot.duration === 6));
});

test('invalid or excluded panels are explicit and never create partial recipes', async () => {
  const project = await fixture();
  project.panels[1].artwork_revision = null;
  const recipes = panelVideoRecipes(project, project.panels.map(panel => panel.id), '960:960');
  assert.equal(recipes[1].valid, false);
  assert.match(recipes[1].reason, /採用済み/);
  assert.throws(() => createPanelVideoShots(project, [
    { panelId: 'panel-0', prompt: 'move', enabled: true },
    { panelId: 'panel-1', prompt: 'move', enabled: true },
  ], { duration: 5, ratio: '960:960' }), /panel-1/);
  const created = createPanelVideoShots(project, [
    { panelId: 'panel-0', prompt: 'move', enabled: true },
    { panelId: 'panel-1', prompt: '', enabled: false },
  ], { duration: 5, ratio: '960:960' });
  assert.equal(created.shotIds.length, 1);
});

test('batch recipes retain exact SourceRefs instead of widening to a whole paragraph', async () => {
  const project = await fixture(1);
  const panel = project.panels[0];
  panel.sourceRefs = [{ snapshotId: panel.snapshotId, sceneId: panel.sceneId, startCp: 1, endCp: 5 }];
  panel.unitIds = [];
  project.artworks[0].panel = structuredClone(panel);
  const created = createPanelVideoShots(project, [{ panelId: panel.id, prompt: 'small motion' }], { duration: 5, ratio: '960:960' });
  assert.deepEqual(created.project.videoShots[0].sourceRefs, panel.sourceRefs);
  const connection = { id: 'connection', provider: 'runway', model: 'gen4_turbo', adapter_id: 'runway' };
  const started = await beginVideoJob(created.project, created.shotIds[0], connection);
  assert.deepEqual(started.job.manifest.source.sourceRefs, panel.sourceRefs);
  const changed = structuredClone(started.project);
  changed.videoShots[0].sourceRefs[0].endCp = 6;
  changed.jobs.at(-1).status = 'abandoned';
  await assert.rejects(beginVideoJob(changed, created.shotIds[0], connection), /原稿・採用作画版/);
});

test('each batch recipe freezes its own model, input hash and cost boundary when started sequentially', async () => {
  const project = await fixture(2);
  const created = createPanelVideoShots(project, project.panels.map(panel => ({ panelId: panel.id, prompt: `move ${panel.id}` })), { duration: 5, ratio: '960:960' });
  const connection = { id: 'connection', provider: 'runway', model: 'gen4_turbo', adapter_id: 'runway' };
  let next = created.project;
  const jobs = [];
  for (const shotId of created.shotIds) {
    const started = await beginVideoJob(next, shotId, connection);
    next = started.project; jobs.push(started.job);
  }
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0].id, jobs[1].id);
  assert.notEqual(jobs[0].input_hash, jobs[1].input_hash);
  assert.ok(jobs.every(job => job.manifest.connection.model === 'gen4_turbo' && job.status === 'running'));
  const stale = structuredClone(next);
  stale.jobs = stale.jobs.map(job => jobs.some(item => item.id === job.id) ? { ...job, status: 'abandoned' } : job);
  stale.panels[0].artwork_revision = null;
  await assert.rejects(beginVideoJob(stale, created.shotIds[0], connection), /採用作画版/);
});
