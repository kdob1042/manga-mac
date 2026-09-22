import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptanceFixture, assertAcceptanceProject, acceptanceProjectHash, createAcceptanceSession, ACCEPTANCE_MODEL } from '../src/acceptance.js';
import { migrateProject, imageHash } from '../src/revisions.js';
import { generatePanel } from '../src/pipeline.js';
import { PAGE } from '../src/layout.js';
const sessionId = '17630fa0-98b5-42d9-82a6-3690b37ebf33';
const image = 'data:image/png;base64,YQ==';
const nativeOrder = v => Array.isArray(v) ? v.map(nativeOrder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, nativeOrder(v[k])])) : v;

function harness(options = {}) {
  let stored = null, generated = 0, saved = 0;
  const records = {}, calls = [], context = { sessionId, resumed: false, stages: {}, ...options.context };
  const deps = {
    context,
    load: async () => stored ? migrateProject(stored, true) : null,
    // Match serde_json Map ordering across native save/read boundaries.
    save: async p => { saved++; stored = nativeOrder(await migrateProject(p)); return structuredClone(stored); },
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'acceptance_record_stage') records[args.stage] = { status: args.status, evidence: args.evidence };
      if (command === 'acceptance_export') return { sha256: await imageHash(args.image), bytes: 1, width: PAGE.width, height: PAGE.height };
      if (command === 'recover_image') throw Error('receipt not available');
      return {};
    },
    generate: async (...args) => {
      generated++;
      assert.equal(args[9], ACCEPTANCE_MODEL);
      assert.equal(args[10], 'direct');
      assert.deepEqual(args[11], { resolution: [256, 256] });
      return { ...args[0], image, generation: { registry_id: ACCEPTANCE_MODEL, model: 'flux_2_klein_4b_q6p.ckpt', width: 256, height: 256, steps: 4, seed: 1 }, attempts: 1 };
    },
    render: async (...args) => {
      assert.equal(args[0][0].image, image);
      assert.equal(args[1][0].scenes[0].text, 'こんにちは。文字と保存の確認です。');
      assert.equal(args[4].slots.length, 1);
      assert.equal(args[5], false, 'export must use strict production rendering');
      return image;
    },
    ...options.deps,
  };
  return { deps, records, calls, get stored() { return stored; }, get generated() { return generated; }, get saved() { return saved; }, setStored: p => { stored = structuredClone(p); }, session: createAcceptanceSession(deps) };
}

test('synthetic fixture has sealed Japanese source and a single full page; no external credentials or reference assets', async () => {
  const p = assertAcceptanceProject(await createAcceptanceFixture());
  assert.match(p.snapshots[0].scenes[0].sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(p.characters.length, 0);
  assert.equal(p.layout.pages[0].slots[0].panelId, p.panels[0].id);
  const points = p.layout.pages[0].slots[0].points;
  assert.ok(points[1][0] - points[0][0] > 0.9);
  assert.ok(points[2][1] - points[1][1] > 0.9);
  assert.equal(p.mediaDefaults.image, ACCEPTANCE_MODEL);
  assert.equal(p.sourceApplication.units.length, 0);
  assert.throws(() => assertAcceptanceProject({ ...p, workId: 'real-work' }), /確認用作品/);
});

test('loading is read-only; explicit run uses production jobs once and repeat run preserves completed art', async () => {
  const h = harness();
  await h.session.load();
  assert.equal(h.saved, 0); assert.equal(h.generated, 0); assert.deepEqual(h.calls, []);
  await h.session.run();
  assert.equal(h.generated, 1);
  assert.equal(h.stored.jobs.filter(job => job.kind === 'generate').length, 1);
  assert.equal(h.stored.jobs.find(job => job.kind === 'generate').status, 'complete');
  assert.equal(h.stored.sourceApplication.units.length, 1);
  assert.equal(h.stored.sourceApplication.units[0].requiredText.length, 2);
  assert.equal(h.stored.namePlan.productionState, 'proof-ready');
  assert.equal(h.stored.panels[0].letteringArtworkRevision, h.stored.panels[0].artwork_revision);
  for (const id of ['name_v2_compiler', 'fixture_save', 'fixture_reload', 'generation', 'adoption', 'renderer', 'export_png']) assert.equal(h.records[id].status, 'PASS', id);
  for (const id of ['restart', 'visual_review', 'p01_review']) assert.equal(h.records[id], undefined, id);
  const before = await acceptanceProjectHash(h.stored);
  await h.session.run();
  assert.equal(h.generated, 1);
  assert.equal(await acceptanceProjectHash(h.stored), before);
  assert.ok(h.calls.every(c => !['prepare_media_engine', 'prepare_engine', 'github_file', 'github_asset', 'source_library'].includes(c.command)));
});

test('lost image response remains unknown across reload and cannot be sent again', async () => {
  let submitted = 0;
  const h = harness({ deps: { generate: async () => { submitted++; throw Error('lost response'); } } });
  await assert.rejects(h.session.run(), /lost response/);
  assert.equal(h.records.generation.status, 'FAIL');
  assert.equal(h.stored.jobs.find(job => job.kind === 'generate').status, 'unknown');
  assert.equal(h.records.renderer, undefined);
  const resumed = createAcceptanceSession({ ...h.deps, context: { sessionId, resumed: true, stages: h.records } });
  await resumed.load();
  await assert.rejects(resumed.run(), /未確定/);
  await assert.rejects(resumed.recover(), /receipt not available/);
  assert.equal(submitted, 1);
  assert.equal(h.stored.jobs.filter(job => job.kind === 'generate').length, 1);
});

test('save failure before submission sends no image request', async () => {
  const h = harness({ deps: { save: async () => { throw Error('disk full'); } } });
  await assert.rejects(h.session.run(), /disk full/);
  assert.equal(h.generated, 0);
  assert.equal(h.records.fixture_save.status, 'FAIL');
  assert.equal(h.records.generation, undefined);
});

test('restart requires the prior baseline and checks persisted semantic data without inference', async () => {
  const h = harness();
  await h.session.run();
  await assert.rejects(h.session.verifyRestart(), /終了・再起動/);
  const resumed = createAcceptanceSession({ ...h.deps, context: { sessionId, resumed: true, stages: h.records } });
  const before = h.generated;
  await resumed.load(); await resumed.verifyRestart();
  assert.equal(h.generated, before);
  assert.equal(h.records.restart.status, 'PASS');
  const changed = structuredClone(h.stored);
  changed.panels[0].prompt = 'changed';
  h.setStored(changed);
  await assert.rejects(resumed.verifyRestart(), /一致しません/);
  assert.equal(h.records.restart.status, 'FAIL');
});

test('a resumed but empty session cannot generate and count the same launch as restart verification', async () => {
  const h = harness({ context: { resumed: true } });
  await h.session.run();
  await assert.rejects(h.session.verifyRestart(), /再起動前の保存済み作画の記録/);
  assert.equal(h.records.restart.status, 'FAIL');
  assert.equal(h.generated, 1);
});

test('project hash ignores serialization key order but detects source, image, lettering and layout changes', async () => {
  const h = harness(); await h.session.run();
  const p = h.stored, original = await acceptanceProjectHash(p);
  const reorder = v => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, reorder(v[k])])) : v;
  assert.equal(await acceptanceProjectHash(reorder(p)), original);
  for (const mutate of [p => { p.panels[0].image += 'x'; }, p => { p.snapshots[0].scenes[0].text += 'x'; }, p => { p.panels[0].lettering.boxes[0].x = 0.5; }, p => { p.layout.pages[0].slots[0].points[0][0] = 0.04; }]) {
    const changed = structuredClone(p); mutate(changed);
    assert.notEqual(await acceptanceProjectHash(changed), original);
  }
});

test('renderer failure cannot pass export or visual review; accepted generation remains reusable', async () => {
  const h = harness({ deps: { render: async () => { throw Error('文字が枠に収まりません'); } } });
  await assert.rejects(h.session.run(), /文字が枠/);
  assert.equal(h.records.generation.status, 'PASS');
  assert.equal(h.records.adoption, undefined);
  assert.equal(h.records.renderer.status, 'FAIL');
  assert.equal(h.records.export_png, undefined);
  assert.equal(h.records.visual_review, undefined);
  assert.equal(h.generated, 1);
  assert.equal(h.stored.sourceApplication.units.length, 0);
  assert.notEqual(h.stored.namePlan.productionState, 'proof-ready');
});

test('v2 compiler evidence rejects changed stored geometry before saving or generating', async () => {
  const h = harness(), p = await createAcceptanceFixture();
  p.layout.pages[0].slots[0].points[0][0] += 0.01;
  h.setStored(p);
  await assert.rejects(h.session.run(), /v2コンパイラ/);
  assert.equal(h.generated, 0);
  assert.equal(h.saved, 0);
});

test('generation dimensions validate before IPC and cannot override an edit or finishing request', async () => {
  const p = await createAcceptanceFixture(), panel = p.panels[0];
  await assert.rejects(generatePanel(panel, [], null, '', null, null, [], null, null, ACCEPTANCE_MODEL, 'direct', { resolution: [255, 256] }), /寸法/);
  await assert.rejects(generatePanel(panel, [], image, '', null, null, [], null, null, ACCEPTANCE_MODEL, 'direct', { resolution: [256, 256] }), /新規の直接作画/);
});
