import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, stat, symlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runDirector } from '../tools/manga-director/loop.mjs';
import { createDirectorAdapter } from '../tools/manga-director/adapter.mjs';
import { digest, canonical, prepareInput } from '../tools/manga-director/data.mjs';
import { sourceResolver } from '../src/source-refs.js';
import { fixtureAdapter, ORIGINAL, INSERTION, issue, scriptSuggestion, directionSuggestion } from './fixtures/manga-director-adapter.mjs';

const input = () => ({ snapshot: { id: 'snapshot-1', workId: 'fictional-work', commit: 'a'.repeat(40),
  scenes: [{ id: 'scene-1', text: ORIGINAL }, { id: 'scene-2', text: '別の場面。変更してはいけない。' }] },
  selectedSceneIds: ['scene-1'], context: { characterNote: '二人は初対面。' } });
const clear = { issues: [], suggestions: [] };

// All plan/LLM doubles are labeled fixture; none of these assert #253/#257 compatibility.
test('two rounds retain a concrete working edit without changing canonical input', async () => {
  const value = input(), before = JSON.stringify(value), events = [];
  const r = await runDirector(value, fixtureAdapter(), { checkpoint: async e => events.push(e) });
  assert.equal(r.stopReason, 'no_major_issues'); assert.equal(r.modelCalls, 4);
  assert.equal(r.iterations.length, 2); assert.equal(r.selectedIteration, 2);
  assert.equal(JSON.stringify(value), before);
  assert.equal(r.workingSnapshot.scenes[0].text, ORIGINAL.replace('アキが声をかける。', INSERTION + 'アキが声をかける。'));
  assert.equal(r.workingSnapshot.scenes[1].text, value.snapshot.scenes[1].text);
  assert.notEqual(r.workingSnapshot.id, value.snapshot.id); assert.equal(r.workingSnapshot.commit, null);
  assert.equal(r.namePlan.sourceHash, digest(r.workingSnapshot));
  assert.equal(r.finalDiff.length, 1); assert.equal(r.finalDiff[0].before, ORIGINAL);
  assert.equal(r.iterations[0].decisions[0].status, 'retained_in_working');
  assert.equal(r.humanApproval, 'pending'); assert.equal(r.handoff.state, 'candidate_only');
  assert.equal(r.handoff.requiresApprovedSourceRebinding, true);
  assert.equal(events.filter(e => e.event === 'stage_started').length, 6);
  assert.equal(events.at(-1).event, 'stopped');
});

test('direction-only changes replan without touching script; old refs keep their snapshot', async () => {
  let planningCalls = 0;
  const r = await runDirector(input(), fixtureAdapter({
    async plan(request) {
      planningCalls++;
      if (planningCalls === 2) {
        assert.equal(request.directionInstructions[0].basisSnapshotId, request.previousPlan.snapshot.id);
        sourceResolver([request.previousPlan.snapshot])(request.directionInstructions[0].sourceRefs[0]);
      }
      return fixtureAdapter().plan(request);
    },
    async review({ snapshot, iteration }) { return iteration === 1
      ? { issues: [issue()], suggestions: [directionSuggestion(snapshot)] } : clear; },
  }));
  assert.equal(planningCalls, 2); assert.deepEqual(r.finalDiff, []);
  assert.equal(r.workingSnapshot.id, 'snapshot-1'); assert.equal(r.namePlan.directions.length, 1);
});

test('iteration limit never leaves an edited script paired with a pre-edit plan', async () => {
  const r = await runDirector(input(), fixtureAdapter(), { limits: { maxIterations: 1 } });
  assert.equal(r.stopReason, 'iteration_limit'); assert.deepEqual(r.finalDiff, []);
  assert.equal(r.namePlan.sourceHash, digest(r.workingSnapshot));
  assert.equal(r.iterations[0].decisions[0].status, 'not_applied');
});

for (const count of [1, 2]) test(`unchanged/worse review (${count} major issues) rolls back trial`, async () => {
  const r = await runDirector(input(), fixtureAdapter({ async review({ snapshot, iteration }) {
    return iteration === 1 ? { issues: [issue()], suggestions: [scriptSuggestion(snapshot)] }
      : { issues: Array.from({ length: count }, (_, i) => issue(`still-${i}`)), suggestions: [] };
  } }));
  assert.equal(r.stopReason, 'no_improvement'); assert.equal(r.selectedIteration, 1);
  assert.deepEqual(r.finalDiff, []); assert.equal(r.workingSnapshot.id, 'snapshot-1');
  assert.equal(r.iterations[0].decisions[0].status, 'rolled_back');
});

test('a repeated normalized proposal stops even with different suggestion IDs', async () => {
  const r = await runDirector(input(), fixtureAdapter({ async review({ snapshot, iteration }) {
    const suggestion = directionSuggestion(snapshot); suggestion.id += iteration;
    if (iteration === 2) suggestion.instruction = '  ' + suggestion.instruction + '  ';
    return { issues: iteration === 1 ? [issue(), issue('other')] : [issue()], suggestions: [suggestion] };
  } }));
  assert.equal(r.stopReason, 'repeated_proposal'); assert.equal(r.iterations.length, 2);
  assert.equal(r.iterations[1].decisions[0].status, 'repeated');
});

test('a failing replan preserves the last reviewed script and plan', async () => {
  let calls = 0;
  const r = await runDirector(input(), fixtureAdapter({ async plan(request) {
    if (++calls === 2) throw Error('API key=secret-do-not-save');
    return fixtureAdapter().plan(request);
  } }));
  assert.equal(r.stopReason, 'ADAPTER_OR_CHECKPOINT_FAILED'); assert.equal(calls, 2);
  assert.equal(r.selectedIteration, 1); assert.equal(r.namePlan.sourceHash, digest(r.workingSnapshot));
  assert.equal(JSON.stringify(r).includes('secret-do-not-save'), false);
});

test('shared validation rejection does not run review or fabricate another plan', async () => {
  let reviews = 0;
  const r = await runDirector(input(), fixtureAdapter({ async validatePlan() { return { ok: false }; },
    async review() { reviews++; return clear; } }));
  assert.equal(r.stopReason, 'INVALID_PLAN'); assert.equal(reviews, 0); assert.equal(r.namePlan, null);
});

test('failed validation after edit rolls back to the original reviewed pair', async () => {
  const r = await runDirector(input(), fixtureAdapter({ async validatePlan(request) {
    const result = await fixtureAdapter().validatePlan(request);
    return { ...result, ok: request.snapshot.id === 'snapshot-1' };
  } }));
  assert.equal(r.stopReason, 'INVALID_PLAN'); assert.equal(r.selectedIteration, 1);
  assert.deepEqual(r.finalDiff, []); assert.equal(r.iterations[0].decisions[0].status, 'rolled_back');
});

const invalidReviews = [
  ['STALE_SOURCE_REF', s => { s.edits[0].ref.snapshotId = 'stale'; }],
  ['OUTSIDE_SELECTION', s => { s.edits[0].ref.sceneId = 'scene-2'; }],
  ['SOURCE_TEXT_MISMATCH', s => { s.edits[0].expectedText = '違う文字'; }],
  ['UNKNOWN_FIELD', s => { s.command = 'execute untrusted code'; }],
  ['UNKNOWN_PLAN_TARGET', s => { s.impact.pageIds = ['not-a-page']; }],
  ['INVALID_EDIT_OPERATION', s => { s.edits[0].op = 'write_file'; }],
  ['INVALID_BENEFIT', s => { s.benefit = -1; }],
  ['NO_OP_EDIT', s => { s.edits[0].op = 'replace'; s.edits[0].text = s.edits[0].expectedText; }],
];
for (const [code, alter] of invalidReviews) test(`invalid review stops safely: ${code}`, async () => {
  const r = await runDirector(input(), fixtureAdapter({ async review({ snapshot }) {
    const s = scriptSuggestion(snapshot); alter(s); return { issues: [issue()], suggestions: [s] };
  } }));
  assert.equal(r.stopReason, code); assert.deepEqual(r.finalDiff, []); assert.equal(r.modelCalls, 2);
});

test('direction_only cannot smuggle script edits', async () => {
  const r = await runDirector(input(), fixtureAdapter({ async review({ snapshot }) {
    const s = directionSuggestion(snapshot); s.edits = scriptSuggestion(snapshot).edits;
    return { issues: [issue()], suggestions: [s] };
  } }));
  assert.equal(r.stopReason, 'UNKNOWN_FIELD');
});

test('overlapping proposals are rejected atomically', async () => {
  const r = await runDirector(input(), fixtureAdapter({ async review({ snapshot }) {
    const a = scriptSuggestion(snapshot), b = scriptSuggestion(snapshot); b.id = 'another';
    return { issues: [issue()], suggestions: [a, b] };
  } }));
  assert.equal(r.stopReason, 'OVERLAPPING_EDITS'); assert.deepEqual(r.finalDiff, []);
});

test('Unicode scalar edits preserve emoji, ZWJ and combining marks exactly', async () => {
  const value = input(); value.snapshot.scenes[0].text = '😀👩‍🚀e\u0301\n\n' + ORIGINAL;
  const r = await runDirector(value, fixtureAdapter());
  assert.equal(r.stopReason, 'no_major_issues');
  assert.equal(r.workingSnapshot.scenes[0].text, value.snapshot.scenes[0].text.replace('アキが声をかける。', INSERTION + 'アキが声をかける。'));
});

test('deterministic hashes and output are unchanged on replaying fixed responses', async () => {
  const a = await runDirector(input(), fixtureAdapter()), b = await runDirector(input(), fixtureAdapter());
  assert.equal(digest(a), digest(b)); assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});

test('invalid input fails before the provider executes', async () => {
  const value = input(); value.snapshot.scenes[1].id = 'scene-1'; let calls = 0;
  await assert.rejects(runDirector(value, fixtureAdapter({ plan() { calls++; } })), /DUPLICATE_ID/);
  assert.equal(calls, 0);
});

test('unsupported adapter and non-JSON input do not use fallback', async () => {
  await assert.rejects(runDirector(input(), { ...fixtureAdapter(), contract: 'other/v1' }), /ADAPTER_CONTRACT/);
  assert.throws(() => prepareInput({ ...input(), context: { fn: () => {} } }), /NON_JSON_VALUE/);
  assert.throws(() => canonical(JSON.parse('{"__proto__":1}')), /UNSAFE_KEY/);
  const cycle = {}; cycle.self = cycle; assert.throws(() => canonical(cycle), /PAYLOAD_DEPTH/);
});

test('model call budget stops before the next call', async () => {
  let plans = 0;
  const r = await runDirector(input(), fixtureAdapter({ async plan(request) {
    plans++; return fixtureAdapter().plan(request);
  } }), { limits: { maxModelCalls: 2 } });
  assert.equal(r.stopReason, 'MODEL_CALL_LIMIT'); assert.equal(plans, 1);
  assert.equal(r.modelCalls, 2); assert.equal(r.selectedIteration, 1); assert.deepEqual(r.finalDiff, []);
});

test('timeout stops the loop without retry', async () => {
  const r = await runDirector(input(), fixtureAdapter({ plan: () => new Promise(() => {}) }), { limits: { stageTimeoutMs: 10 } });
  assert.equal(r.stopReason, 'STAGE_TIMEOUT'); assert.equal(r.modelCalls, 1);
});

test('cancellation before invocation spends no call budget', async () => {
  const controller = new AbortController(); controller.abort();
  const r = await runDirector(input(), fixtureAdapter(), { signal: controller.signal });
  assert.equal(r.stopReason, 'ABORTED'); assert.equal(r.modelCalls, 0);
});

test('cancellation propagates to the adapter AbortSignal', async () => {
  const controller = new AbortController(); let observed;
  const r = await runDirector(input(), fixtureAdapter({ async plan(_, { signal }) {
    observed = signal; controller.abort(); return new Promise(() => {});
  } }), { signal: controller.signal });
  assert.equal(r.stopReason, 'ABORTED'); assert.equal(observed.aborted, true);
});

test('text growth is checked against original content, not just the previous round', async () => {
  const r = await runDirector(input(), fixtureAdapter(), { limits: { maxAddedCp: 1 } });
  assert.equal(r.stopReason, 'TEXT_GROWTH_LIMIT'); assert.deepEqual(r.finalDiff, []);
});

test('actual page growth is checked even if a suggestion predicted zero growth', async () => {
  const r = await runDirector(input(), fixtureAdapter({ async validatePlan(request) {
    const index = await fixtureAdapter().validatePlan(request);
    if (request.snapshot.id !== 'snapshot-1') index.pageIds.push('page-2');
    return index;
  } }), { limits: { maxAddedPages: 0 } });
  assert.equal(r.stopReason, 'PAGE_GROWTH_LIMIT'); assert.equal(r.selectedIteration, 1);
});

test('low-benefit suggestions stop without editing the manuscript', async () => {
  const r = await runDirector(input(), fixtureAdapter(), { limits: { minBenefit: 0.9 } });
  assert.equal(r.stopReason, 'no_actionable_suggestions'); assert.deepEqual(r.finalDiff, []);
});

test('provider cannot mutate frozen request data through the API', async () => {
  const value = input();
  const r = await runDirector(value, fixtureAdapter({ async plan(request) { request.snapshot.scenes[0].text = 'overwrite'; } }));
  assert.equal(r.stopReason, 'ADAPTER_OR_CHECKPOINT_FAILED'); assert.equal(value.snapshot.scenes[0].text, ORIGINAL);
});

test('source drift aborts before a response is accepted', async () => {
  let changed = false;
  const r = await runDirector(input(), fixtureAdapter({ async plan(request) {
    changed = true; return fixtureAdapter().plan(request);
  } }), { assertSourceUnchanged: async () => { if (changed) throw Error('changed'); } });
  assert.equal(r.stopReason, 'SOURCE_CHANGED'); assert.equal(r.namePlan, null);
});

test('pending-state persistence failure prevents the provider from executing', async () => {
  let calls = 0;
  await assert.rejects(runDirector(input(), fixtureAdapter({ plan() { calls++; } }), {
    checkpoint: async () => { throw Error('disk full'); },
  }));
  assert.equal(calls, 0);
});

test('host adapter reuses one-shot callbacks and sends the separate review policy', async () => {
  const fixture = fixtureAdapter(); let completions = 0;
  const host = createDirectorAdapter({ name: 'test-host', version: '1', planName: fixture.plan,
    validateName: fixture.validatePlan, complete: async (messages, options) => {
      completions++; assert.ok(messages[0].content.includes('direction_only'));
      assert.ok(options.signal instanceof AbortSignal); return JSON.stringify(clear);
    } });
  const r = await runDirector(input(), host);
  assert.equal(completions, 1); assert.equal(r.stopReason, 'no_major_issues');
});

const cli = fileURLToPath(new URL('../tools/manga-director/cli.mjs', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/manga-director-adapter.mjs', import.meta.url));
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'director-test-'));
  t.after(async () => { await rm(dir, { force: true, recursive: true }); });
  const value = input(); value.snapshot.scenes[0].path = 'scene.md'; delete value.snapshot.scenes[0].text;
  await writeFile(path.join(dir, 'scene.md'), ORIGINAL); await chmod(path.join(dir, 'scene.md'), 0o444);
  await writeFile(path.join(dir, 'input.json'), JSON.stringify(value));
  const out = path.join(dir, 'run');
  const invoke = (extra = [], adapter = fixturePath) => spawnSync(process.execPath, [cli,
    '--input', path.join(dir, 'input.json'), '--out', out, '--adapter', adapter, ...extra], { encoding: 'utf8', timeout: 10000 });
  return { dir, out, invoke };
}

test('CLI runs two rounds in a new private directory, leaves read-only script unchanged', async t => {
  const { dir, out, invoke } = await workspace(t);
  const process = invoke(['--allow-fixture']); assert.equal(process.status, 0, process.stderr);
  assert.equal(await readFile(path.join(dir, 'scene.md'), 'utf8'), ORIGINAL);
  const r = JSON.parse(await readFile(path.join(out, 'result.json'), 'utf8'));
  assert.equal(r.iterations.length, 2); assert.equal(r.adapter.mode, 'fixture');
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(out, 'result.json'))).mode & 0o777, 0o600);
  assert.equal(process.stdout.includes(ORIGINAL), false); assert.equal(process.stderr, '');
  assert.ok(await readFile(path.join(out, 'events.jsonl'), 'utf8'));
  const again = invoke(['--allow-fixture']); assert.equal(again.status, 2);
  assert.equal(await readFile(path.join(dir, 'scene.md'), 'utf8'), ORIGINAL);
});

test('CLI never silently uses the fixture as a live AI', async t => {
  const { out, invoke } = await workspace(t);
  const process = invoke(); assert.equal(process.status, 2); assert.match(process.stderr, /FIXTURE_NOT_ALLOWED/);
  await assert.rejects(access(out));
});

test('CLI rejects parent paths and symlinks instead of escaping the source root', async t => {
  const { dir, out, invoke } = await workspace(t);
  const value = input(); delete value.snapshot.scenes[0].text;
  value.snapshot.scenes[0].path = '../secret.md';
  await writeFile(path.join(dir, 'input.json'), JSON.stringify(value));
  let result = invoke(['--allow-fixture']); assert.equal(result.status, 2); assert.match(result.stderr, /UNSAFE_SOURCE_PATH/);
  await symlink(path.join(dir, 'scene.md'), path.join(dir, 'linked.md'));
  value.snapshot.scenes[0].path = 'linked.md';
  await writeFile(path.join(dir, 'input.json'), JSON.stringify(value));
  result = invoke(['--allow-fixture']); assert.equal(result.status, 2); assert.match(result.stderr, /SOURCE_SYMLINK/);
  await assert.rejects(access(out));
});

test('CLI rejects model-selected module fields before loading any adapter', async t => {
  const { dir, invoke } = await workspace(t);
  await writeFile(path.join(dir, 'input.json'), JSON.stringify({ ...input(), adapter: 'malicious.mjs' }));
  const result = invoke(['--allow-fixture']); assert.equal(result.status, 2); assert.match(result.stderr, /UNKNOWN_FIELD/);
});

test('CLI stores no completion receipt when a canonical source changes concurrently', async t => {
  const { dir, out, invoke } = await workspace(t);
  await chmod(path.join(dir, 'scene.md'), 0o600);
  const custom = path.join(dir, 'guard-test.mjs');
  await writeFile(custom, `import fixture from ${JSON.stringify(new URL('./fixtures/manga-director-adapter.mjs', import.meta.url).href)};
import {writeFile} from 'node:fs/promises';
export default {...fixture, async plan(r){ await writeFile(${JSON.stringify(path.join(dir, 'scene.md'))}, 'concurrent writer'); return fixture.plan(r); }};`);
  const process = invoke(['--allow-fixture'], custom); assert.equal(process.status, 2);
  await assert.rejects(access(path.join(out, 'result.json')));
  const failure = JSON.parse(await readFile(path.join(out, 'failure.json'), 'utf8'));
  assert.equal(failure.code, 'SOURCE_CHANGED');
  assert.equal(await readFile(path.join(dir, 'scene.md'), 'utf8'), 'concurrent writer');
});

test('mixed direction/script trials keep old source references resolvable after insertion', async () => {
  const r = await runDirector(input(), fixtureAdapter({
    async plan(request) {
      if (request.iteration === 2) {
        const direction = request.directionInstructions[0];
        assert.notEqual(direction.basisSnapshotId, request.snapshot.id);
        assert.equal(direction.basisSnapshotId, request.previousPlan.snapshot.id);
        assert.equal(sourceResolver([request.previousPlan.snapshot])(direction.sourceRefs[0]), 'アキが声をかける。');
      }
      return fixtureAdapter().plan(request);
    },
    async review({ snapshot, iteration }) { return iteration === 1
      ? { issues: [issue()], suggestions: [scriptSuggestion(snapshot), directionSuggestion(snapshot)] } : clear; },
  }));
  assert.equal(r.stopReason, 'no_major_issues'); assert.equal(r.finalDiff.length, 1);
});

for (const op of ['replace', 'delete']) test(`exact ${op} edits are applied only to the working copy`, async () => {
  const r = await runDirector(input(), fixtureAdapter({ async review({ snapshot, iteration }) {
    if (iteration === 2) return clear;
    const s = scriptSuggestion(snapshot); s.edits[0].op = op;
    s.edits[0].text = op === 'delete' ? '' : 'アキが静かに声をかける。';
    return { issues: [issue()], suggestions: [s] };
  } }));
  assert.equal(r.stopReason, 'no_major_issues');
  assert.equal(r.workingSnapshot.scenes[0].text, ORIGINAL.replace('アキが声をかける。', op === 'delete' ? '' : 'アキが静かに声をかける。'));
  assert.equal(r.finalDiff[0].before, ORIGINAL);
});

test('bad JSON from a completion host is not repaired by a hidden model call', async () => {
  let calls = 0; const fixture = fixtureAdapter();
  const host = createDirectorAdapter({ name: 'bad-host-fixture', version: '1',
    planName: fixture.plan, validateName: fixture.validatePlan,
    complete: async () => { calls++; return '```json invalid ```'; } });
  const r = await runDirector(input(), host);
  assert.equal(r.status, 'blocked'); assert.equal(r.stopReason, 'ADAPTER_OR_CHECKPOINT_FAILED'); assert.equal(calls, 1);
});

test('CLI snapshots selected input/context and only writes receipt after all artifacts', async t => {
  const { out, invoke } = await workspace(t); const result = invoke(['--allow-fixture']);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(await readFile(path.join(out, 'input-snapshot.json'), 'utf8'));
  assert.equal(saved.snapshot.scenes[0].text, ORIGINAL); assert.deepEqual(saved.selectedSceneIds, ['scene-1']);
  for (const file of ['name-plan.json', 'working-manuscript.json', 'script-suggestions.json', 'final-diff.json', 'result.json']) await access(path.join(out, file));
});

test('invalid limits are rejected instead of silently expanding the budget', async () => {
  for (const limits of [{ maxIterations: 0 }, { maxIterations: 31 }, { maxModelCalls: Infinity }, { hiddenRetries: 3 }]) {
    await assert.rejects(runDirector(input(), fixtureAdapter(), { limits }), /INVALID_LIMIT|UNKNOWN_LIMIT/);
  }
});
