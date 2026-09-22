import test from 'node:test';
import assert from 'node:assert/strict';
import { createNameCandidate, createNameFile, adoptNameCandidate, validateV2State, refreshNameMetadata, patchNameLayout, setNameLock, localNamePlan, requiredTextForSource, canFinalizeNameRef, nameReadToken } from '../src/name-v2.js';
import { generateNameCandidate, proposeNameEdit, applyNameEdit, runNameVisualQA } from '../src/name-v2-ai.js';
import { sourceParagraphs, orderedCoverage, sourceDescriptor } from '../contracts/name-plan/source.mjs';
import { fileFixture, split, leaf } from './name-plan-fixture.mjs';

test('real v2 adapter imports native panels/layout, adopts and survives JSON persistence', async () => {
  const f = await fileFixture(3), before = structuredClone(f.project), c = await createNameCandidate(f.project, JSON.stringify(f.file));
  const p = await adoptNameCandidate(f.project, c); assert.deepEqual(f.project, before);
  assert.equal(p.panels.length, 3); assert.equal(p.layout.pages.length, 1); assert.equal(p.namePlan.status, 'adopted');
  assert.ok(p.panels.every(panel => panel.requiredText.length === 0 && panel.lettering.boxes.length === 0 && panel.namePlanVersion === 2));
  assert.equal(p.sourceApplication.units.length, 0); assert.equal(p.history.at(-1).draftCheckpoint, true);
  const restored = refreshNameMetadata(JSON.parse(JSON.stringify(p))); assert.equal(restored.namePlan.geometryOverride, false); validateV2State(restored);
});
test('portable source character IDs map to app-local IDs only after import', async () => {
  const f = await fileFixture(1), localId = 'local-random-character';
  f.snapshot.characters = [{ id: 'kamiya-yu', name: '神谷 勇', description: '短髪' }];
  f.snapshot.references = [{ characterId: 'kamiya-yu', name: '神谷 勇', path: 'yu.jpg', hash: 'b'.repeat(64) }];
  f.project.characters = [{ id: localId, name: '神谷 勇', description: '短髪', hash: 'b'.repeat(64), source: { repo: f.snapshot.repo, scope: `${f.snapshot.repo}#${f.snapshot.workId}`, character_id: 'kamiya-yu' } }];
  f.plan.panels[0].characterIds = ['kamiya-yu'];
  f.file.source = await sourceDescriptor(f.project, f.snapshot, f.atoms);
  const candidate = await createNameCandidate(f.project, f.file);
  assert.deepEqual(candidate.file.plan.panels[0].characterIds, ['kamiya-yu']);
  assert.deepEqual(candidate.panels[0].characterIds, [localId]);

  const internalPlan = structuredClone(f.plan);
  internalPlan.panels[0].characterIds = [localId];
  const written = await createNameFile(f.project, internalPlan, f.atoms.map(atom => atom.id), { producer: 'fixture', model: '', editedBy: [] });
  assert.deepEqual(written.plan.panels[0].characterIds, ['kamiya-yu']);

  const sameFileHash = written.source.referencesHash;
  f.project.characters[0].id = 'another-local-id';
  const rewritten = await createNameFile(f.project, { ...structuredClone(written.plan), panels: written.plan.panels.map(panel => ({ ...panel, characterIds: ['kamiya-yu'] })) }, f.atoms.map(atom => atom.id), { producer: 'fixture', model: '', editedBy: [] });
  assert.equal(rewritten.source.referencesHash, sameFileHash);

  const unknown = structuredClone(f.file);
  unknown.plan.panels[0].characterIds = ['not-in-work'];
  await assert.rejects(() => createNameCandidate(f.project, unknown), /未登録|対象原稿|人物/);
});
test('printed dialogue vs visual prose and reference metadata are carried to production fields', async () => {
  const f = await fileFixture(2, '# 場面\n\n彼は笑う。「また明日😀」\n\n![参考](art.png)');
  const c = await createNameCandidate(f.project, f.file), p = await adoptNameCandidate(f.project, c);
  const dialogue = p.panels.find(panel => panel.requiredText.length);
  assert.ok(dialogue); assert.equal(dialogue.letteringStatus, 'draft');
  const text = p.namePlan.sourcePolicy.filter(entry => entry.presentation === 'dialogue').flatMap(entry => entry.requiredText);
  assert.ok(orderedCoverage(text, p.panels.flatMap(panel => panel.requiredText)));
  const firstUnit = sourceParagraphs(f.snapshot)[0].source;
  assert.equal(requiredTextForSource(p, firstUnit).length, 1);
  assert.equal(canFinalizeNameRef(p, firstUnit), false);
  p.panels = p.panels.map(panel => ({ ...panel, image: 'fixture-art', letteringStatus: 'ready' }));
  validateV2State(p, { complete: true }); assert.equal(canFinalizeNameRef(p, firstUnit), true);
  dialogue.requiredText = []; // Mutating the former object cannot mutate the immutable updated panels.
  assert.ok(p.panels.some(panel => panel.requiredText.length));
});
test('incomplete draft and missing required lettering are never finished', async () => {
  const f = await fileFixture(1, '# 場面\n\n「省略しない」'), p = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file));
  assert.throws(() => validateV2State(p, { complete: true }), /未完了/);
  p.panels[0].image = 'art'; p.panels[0].letteringStatus = 'ready'; p.panels[0].lettering.boxes = [];
  assert.throws(() => validateV2State(p, { complete: true }), /掲載文字/);
});
test('adoption rejects stale baselines and post-validation candidate mutation', async () => {
  const f = await fileFixture(), c = await createNameCandidate(f.project, f.file);
  const altered = structuredClone(c); altered.panels[0].prompt += 'tampered';
  await assert.rejects(() => adoptNameCandidate(f.project, altered), /検証後/);
  f.project.panels.push({ id: 'other', sourceRefs: [] });
  await assert.rejects(() => adoptNameCandidate(f.project, c), /基準版/);
});
test('scope-limited adoption preserves unrelated pages and source exactly', async () => {
  const f = await fileFixture(8), p1 = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file));
  const raw = structuredClone(f.file), keepAtoms = f.atoms.slice(6).map(atom => atom.id);
  raw.source.selectedAtomIds = keepAtoms; raw.plan.coverage = raw.plan.coverage.slice(6); raw.plan.panels = raw.plan.panels.slice(6); raw.plan.pages = raw.plan.pages.slice(1); raw.plan.beats[0].atomIds = keepAtoms;
  const c2 = await createNameCandidate(p1, raw), p2 = await adoptNameCandidate(p1, c2);
  assert.deepEqual(p2.layout.pages[0], p1.layout.pages[0]); assert.deepEqual(p2.panels.slice(0, 6), p1.panels.slice(0, 6));
  assert.deepEqual(p2.snapshots, p1.snapshots); validateV2State(p2);
});
test('partially overlapping page requests expansion instead of discarding neighbouring panels', async () => {
  const f = await fileFixture(4), p = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file));
  const raw = structuredClone(f.file); raw.source.selectedAtomIds = raw.source.selectedAtomIds.slice(0, 1); raw.plan.coverage = raw.plan.coverage.slice(0, 1); raw.plan.panels = raw.plan.panels.slice(0, 1); raw.plan.beats[0].atomIds = raw.source.selectedAtomIds; raw.plan.pages[0].tree = leaf(raw.plan.panels[0].id);
  const c = await createNameCandidate(p, raw);
  await assert.rejects(() => adoptNameCandidate(p, c), /対象外/);
  const separate = await adoptNameCandidate(p, c, 'separate'); assert.equal(separate.panels.length, 1); assert.equal(separate.history.at(-1).panels.length, 4);
});
test('layout-only edits retain artwork, source and all other pages', async () => {
  const f = await fileFixture(8); let p = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file));
  p.panels = p.panels.map(panel => ({ ...panel, image: 'art', artwork_revision: 'art-id' }));
  const plan = localNamePlan(p.namePlan.file, p.namePlan.namespace), page = plan.pages[0];
  const tree = structuredClone(page.tree); tree.weights = [2, 1, 1];
  const next = await patchNameLayout(p, page.id, tree);
  assert.deepEqual(next.panels, p.panels); assert.deepEqual(next.layout.pages[1], p.layout.pages[1]); assert.notDeepEqual(next.layout.pages[0], p.layout.pages[0]);
  assert.deepEqual(next.history.at(-1).panels, p.panels); validateV2State(next);
});
test('fixed pages reject both AI reflow and raw geometry edits', async () => {
  const f = await fileFixture(2); let p = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file));
  const page = p.layout.pages[0]; p = setNameLock(p, page.id, true);
  const tree = structuredClone(localNamePlan(p.namePlan.file, p.namePlan.namespace).pages[0].tree); tree.weights = [2, 1];
  await assert.rejects(() => patchNameLayout(p, page.id, tree), /固定/);
  const raw = structuredClone(p); raw.layout.pages[0].slots[0].points[0][0] += .01;
  assert.throws(() => refreshNameMetadata(raw), /固定/);
});
test('manual quadrilateral override is persisted, never silently recompiled', async () => {
  const f = await fileFixture(2); let p = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file));
  p.layout.pages[0].slots[0].points[0][0] += .005; const saved = refreshNameMetadata(JSON.parse(JSON.stringify(p)));
  assert.equal(saved.namePlan.geometryOverride, true); assert.deepEqual(saved.layout, p.layout);
  await assert.rejects(() => patchNameLayout(saved, saved.layout.pages[0].id, localNamePlan(saved.namePlan.file, saved.namePlan.namespace).pages[0].tree), /手動/);
});
test('source version change is marked stale without discarding the old draft', async () => {
  const f = await fileFixture(); const p = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file));
  p.snapshots.push({ ...structuredClone(f.snapshot), id: 'new' }); p.active = 'new';
  const next = refreshNameMetadata(p); assert.equal(next.namePlan.status, 'stale'); assert.deepEqual(next.panels, p.panels);
});
function harness(project) { let state = project; return { current: () => state, commit: async next => { state = JSON.parse(JSON.stringify(next)); return state; } }; }
test('configured AI uses actual policy/schema and persists candidate on existing jobs', async () => {
  const f = await fileFixture(), h = harness(f.project); let calls = 0;
  const candidate = await generateNameCandidate({ ...h, model: { provider: 'fixture', model: 'configured', apiKey: 'SECRET' }, ask: async (model, request) => { calls++; assert.equal(request.purpose, 'plan'); assert.ok(request.prompt.includes('name-director/2.0.0')); return JSON.stringify(f.plan); } });
  assert.equal(calls, 1); assert.equal(h.current().jobs[0].status, 'candidate'); assert.equal(h.current().panels.length, 0); assert.ok(candidate.layout);
  assert.equal(JSON.stringify(h.current()).includes('SECRET'), false);
});
test('one structural repair only; transport failure is not retried', async () => {
  const f = await fileFixture(), h = harness(f.project); let calls = 0;
  await generateNameCandidate({ ...h, model: { provider: 'x', model: 'x' }, ask: async () => ++calls === 1 ? '{}' : JSON.stringify(f.plan) }); assert.equal(calls, 2);
  const h2 = harness(f.project); calls = 0;
  await assert.rejects(() => generateNameCandidate({ ...h2, model: { provider: 'x', model: 'x' }, ask: async () => { calls++; throw Error('offline'); } }), /offline/);
  assert.equal(calls, 1); assert.equal(h2.current().jobs[0].status, 'unknown');
});
test('cancellation and stale results are not adopted', async () => {
  const f = await fileFixture(), h = harness(f.project); let stop = false;
  const result = await generateNameCandidate({ ...h, model: { provider: 'x', model: 'x' }, cancelled: () => stop, ask: async () => { stop = true; return JSON.stringify(f.plan); } });
  assert.equal(result, null); assert.equal(h.current().jobs[0].status, 'cancelled'); assert.equal(h.current().panels.length, 0);
});
test('no image input never gets a visual QA pass', async () => {
  const f = await fileFixture(); const p = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file));
  let calls = 0;
  const result = await runNameVisualQA({ project: p, pageIds: p.namePlan.pageIds, images: [], ask: async () => { calls++; }, imageCapable: false });
  assert.equal(result.visual, 'not_run'); assert.equal(calls, 0);
});
test('natural language dispatch is typed and scoped, not arbitrary executable output', async () => {
  const f = await fileFixture(2), p = await adoptNameCandidate(f.project, await createNameCandidate(f.project, f.file)), page = p.layout.pages[0];
  const proposal = await proposeNameEdit(p, page.id, 'このページ固定', async () => ({ kind: 'lock', reason: '固定要求', locked: true }));
  const next = await applyNameEdit(p, proposal); assert.deepEqual(next.namePlan.locks.pages[page.id], page);
  await assert.rejects(() => proposeNameEdit(p, page.id, 'x', async () => ({ kind: 'shell', reason: 'x', command: 'no' })), /形式/);
});

test('name geometry and locks use ordinary Undo/Redo and retain art',async()=>{
 const {undoEdit}=await import('../src/edit-commands.js');
 const f=await fileFixture(2);let p=await adoptNameCandidate(f.project,await createNameCandidate(f.project,f.file));
 const original=structuredClone(p),tree=structuredClone(localNamePlan(p.namePlan.file,p.namePlan.namespace).pages[0].tree);tree.weights=[2,1];
 const edited=await patchNameLayout(p,p.layout.pages[0].id,tree);
 assert.equal(edited.history.at(-1).nameEdit,true);
 const undone=undoEdit(JSON.parse(JSON.stringify(edited)));assert.deepEqual(undone.layout,original.layout);assert.deepEqual(undone.namePlan,original.namePlan);
 const redone=undoEdit(undone,true);assert.deepEqual(redone.layout,edited.layout);assert.deepEqual(redone.namePlan,edited.namePlan);
 const locked=setNameLock(redone,redone.layout.pages[0].id,true);assert.ok(locked.namePlan.locks.pages[redone.layout.pages[0].id]);
 const unlocked=undoEdit(locked);assert.deepEqual(unlocked.namePlan.locks,redone.namePlan.locks);assert.deepEqual(unlocked.panels,original.panels);
});
test('manual candidate geometry is validated and adopted without losing compiler provenance',async()=>{
 const {editNameCandidateLayout}=await import('../src/name-v2.js');
 const f=await fileFixture(2),c=await createNameCandidate(f.project,f.file),layout=structuredClone(c.layout);
 layout.pages[0].slots[0].points[0][0]+=.005;
 const edited=await editNameCandidateLayout(f.project,c,layout),p=await adoptNameCandidate(f.project,edited);
 assert.deepEqual(p.layout.pages,layout.pages);assert.deepEqual(p.namePlan.compiledLayout,c.layout);assert.equal(p.namePlan.geometryOverride,true);
 const restored=refreshNameMetadata(JSON.parse(JSON.stringify(p)));assert.deepEqual(restored.layout,p.layout);
 layout.pages[0].slots[0].panelId='missing';await assert.rejects(()=>editNameCandidateLayout(f.project,c,layout));
});

test('saved atom policy cannot be rebound to different text or lose printed source',async()=>{
 const f=await fileFixture(1,'# Scene\n\n「台詞」'),p=await adoptNameCandidate(f.project,await createNameCandidate(f.project,f.file));
 const moved=structuredClone(p);moved.namePlan.sourcePolicy[0].source.startCp++;
 assert.throws(()=>validateV2State(moved),/位置対応/);
 const hidden=structuredClone(p);hidden.namePlan.sourcePolicy[0].kind='prose';hidden.namePlan.sourcePolicy[0].presentation='visual';hidden.namePlan.sourcePolicy[0].requiredText=[];
 assert.throws(()=>validateV2State(hidden),/位置対応/);
 const altered=structuredClone(p);altered.namePlan.file.plan.workGoal.payoff+='changed';
 const {refreshNameBindings}=await import('../src/name-v2.js');await assert.rejects(()=>refreshNameBindings(altered),/hash/);
});
test('old artwork lettering is not treated as completed new artwork',async()=>{
 const f=await fileFixture(1,'# Scene\n\n「台詞」'),p=await adoptNameCandidate(f.project,await createNameCandidate(f.project,f.file));
 p.panels[0]={...p.panels[0],image:'art',artwork_revision:'new',letteringStatus:'ready',letteringArtworkRevision:'old'};
 assert.throws(()=>validateV2State(p,{complete:true}),/未完了/);
});
