import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateProject, beginJob, finishJob, imageHash } from '../src/revisions.js';
import { sourceForPanel } from '../src/core.js';
const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url)));
test('LEGACY-01 migration is lossless and idempotent; Undo keeps source and exact pixels', async () => {
  const p = await migrateProject(legacy);
  assert.equal(p.version, 3);
  assert.equal(p.output_locale, 'ja');
  assert.deepEqual(p.localizations, []);
  assert.equal(p.panels[0].capture_revision, null);
  assert.equal(p.panels[0].image, legacy.panels[0].image);
  assert.deepEqual(p.characters, legacy.characters);
  assert.deepEqual(p.snapshots, legacy.snapshots);
  assert.equal(sourceForPanel(p.panels[0], p.snapshots[0]), '「原文です」\n\n  次の段落。');
  assert.equal(p.history[0].panels[0].image, legacy.history[0].panels[0].image);
  assert.deepEqual(await migrateProject(p), p);
  assert.equal(p.artworks.find(a => a.id === p.panels[0].artwork_revision).hash, await imageHash(legacy.panels[0].image));
  assert.equal(legacy.version, 1);
  await assert.rejects(migrateProject({ ...p, panels: [{ ...p.panels[0], image: legacy.history[0].panels[0].image }] }));
});
test('SOURCE-01 stale source, changed panel, changed reference and cancellation retain a candidate only', async () => {
  const p = await migrateProject(legacy), job = await beginJob(p, p.panels[0]);
  const base = { ...p, jobs: [...p.jobs, job] };
  for (const state of [
    { ...base, active: 'new-source' },
    { ...base, panels: [{ ...p.panels[0], prompt: 'changed' }] },
    { ...base, characters: [{ ...p.characters[0], hash: 'changed' }] },
    { ...base, panels: [] },
  ]) {
    const result = await finishJob(state, job, p.panels[0]);
    assert.deepEqual(result.panels, state.panels);
    assert.deepEqual(result.history, state.history);
    assert.equal(result.jobs.at(-1).status, 'candidate');
    assert.equal(result.artworks.at(-1).parent_revision, job.base_revision);
  }
  assert.equal((await finishJob(base, job, p.panels[0], true)).jobs.at(-1).status, 'candidate');
});
test('successful job adopts once, retains prior version, and cannot replay after restart', async () => {
  const p = await migrateProject(legacy), job = await beginJob(p, p.panels[0], 'edit');
  const running = { ...p, jobs: [...p.jobs, job] };
  const result = await finishJob(running, job, { ...p.panels[0], instructions: ['新しい意図'] });
  assert.equal(result.panels[0].artwork_revision, `artwork:${job.id}`);
  assert.deepEqual(result.history.at(-1).panels, p.panels);
  assert.deepEqual(result.snapshots, p.snapshots);
  await assert.rejects(finishJob(result, job, p.panels[0]));
  const resumed = await migrateProject(running, true);
  assert.equal(resumed.jobs.at(-1).status, 'unknown');
  await assert.rejects(beginJob(resumed, resumed.panels[0], 'edit'));
  await assert.rejects(finishJob(resumed, job, p.panels[0]));
});


test('English localization survives migration without changing the source', async () => {
  const p = await migrateProject(legacy);
  const localized = {
    ...p,
    output_locale: 'en',
    localizations: [{
      id: `${p.active}:en`,
      snapshot_id: p.active,
      locale: 'en',
      units: [{ id: 'S01:u0', text: 'Original dialogue' }],
      model: { provider: 'ollama', model: 'fixture' },
      created_at: '2026-09-16T00:00:00.000Z',
    }],
  };
  const migrated = await migrateProject(localized);
  assert.equal(migrated.output_locale, 'en');
  assert.deepEqual(migrated.localizations, localized.localizations);
  assert.deepEqual(migrated.snapshots, p.snapshots);
  await assert.rejects(migrateProject({ ...localized, localizations: [{ ...localized.localizations[0], units: [{ id: 'S01:u0', text: '' }] }] }));
});

test('duplicate translated unit IDs are rejected during project reload', async () => {
  const p = await migrateProject(legacy);
  p.localizations = [{ locale: 'en', snapshot_id: 'source', units: [{id:'u',text:'One'},{id:'u',text:'Two'}] }];
  await assert.rejects(migrateProject(p));
});
