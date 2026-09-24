import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT, validatePlan, parseNameFile, MAX_BYTES, canonical, treeLeaves } from '../contracts/name-plan/schema.mjs';
import { atomize, sourceParagraphs, resolveRef, orderedCoverage, bindSource, sourceDescriptor, sourceCharacterIdentity } from '../contracts/name-plan/source.mjs';
import { compileNameLayout, validQuad, overlaps } from '../contracts/name-plan/layout.mjs';
import { CARDS, buildNamePrompt } from '../contracts/name-plan/policy.mjs';
import { diagnosePlan, validateQA } from '../contracts/name-plan/qa.mjs';
import { fixture, fileFixture, split, leaf } from './name-plan-fixture.mjs';

test('v2 file, source hashes and shared model schema round trip', async () => {
  const f = await fileFixture(); const raw = JSON.stringify(f.file);
  assert.equal(parseNameFile(raw).format, FORMAT);
  const bound = await bindSource(parseNameFile(raw), f.project);
  assert.deepEqual(bound.atoms, f.atoms); validatePlan(f.plan, f.atoms, []);
});
for (const text of [
  '# 頭\n\n「また明日😀」\n\n顔を上げる。',
  '# 頭\r\n\r\nか\u3099。\r\n\r\n「もう一度」\r\n',
  '# 頭\n\n言う。「『明日』って言ったよね」彼は笑う。\n\n同じ。\n\n同じ。',
  '# 頭\n\n![秘密のalt](../../assets/hidden.jpg)\n\n本文と**強調**。[表示](https://example.invalid/private)\n',
  '# 頭\n\n<!--secret-->本文「引用」\n',
]) test(`Unicode/Markdown source coverage ${JSON.stringify(text).slice(0, 50)}`, () => {
  const f = fixture(1, text), expected = sourceParagraphs(f.snapshot).map(p => p.source);
  assert.ok(orderedCoverage(expected, f.atoms.map(atom => atom.source)));
  for (const atom of f.atoms) assert.equal(resolveRef([f.snapshot], atom.source), atom.text);
  assert.equal(f.atoms.map(atom => atom.text).join(''), sourceParagraphs(f.snapshot).map(p => p.text).join(''));
  for (const atom of f.atoms.filter(a => /hidden\.jpg|https:|secret/.test(a.text))) assert.equal(atom.kind, 'reference');
});
for (const count of [1, 2, 3, 4, 5, 6, 16]) test(`${count} panels: deterministic, convex, inside, assigned once`, () => {
  const f = fixture(count);
  if (count === 16) {
    f.plan.pages = [{ ...f.plan.pages[0], tree: split('column', [0, 4, 8, 12].map(at => split('row', f.plan.panels.slice(at, at + 4).map(p => leaf(p.id))))) }];
  }
  if (count === 1) f.plan.panels[0].role = 'splash';
  validatePlan(f.plan, f.atoms, []);
  const result = compileNameLayout(f.plan);
  for (let i = 0; i < 100; i++) assert.equal(canonical(compileNameLayout(f.plan)), canonical(result));
  assert.deepEqual(result.layout.pages.flatMap(p => p.slots.map(s => s.panelId)), f.plan.panels.map(p => p.id));
  for (const page of result.layout.pages) for (let i = 0; i < page.slots.length; i++) {
    assert.ok(validQuad(page.slots[i].points));
    for (const other of page.slots.slice(i + 1)) assert.equal(overlaps(page.slots[i].points, other.points), false);
  }
});
for (const type of ['row', 'column']) for (const weights of [[6, 4], [4, 6]]) test(`dominant ${type} ${weights}`, () => {
  const f = fixture(2); f.plan.pages[0].tree = split(type, f.plan.panels.map(p => leaf(p.id)), weights);
  const slots = compileNameLayout(f.plan).layout.pages[0].slots;
  const box = s => [Math.min(...s.points.map(p => p[0])), Math.min(...s.points.map(p => p[1])), Math.max(...s.points.map(p => p[0])), Math.max(...s.points.map(p => p[1]))];
  const [a, b] = slots.map(box);
  if (type === 'row') assert.ok(a[0] > b[2]); else assert.ok(a[3] < b[1]);
  const dim = type === 'row' ? 0 : 1;
  assert.equal(Math.sign((a[dim + 2] - a[dim]) - (b[dim + 2] - b[dim])), Math.sign(weights[0] - weights[1]));
});
for (const type of ['row', 'column']) for (const slant of [-.1, .1]) test(`shared slant ${type} ${slant}`, () => {
  const f = fixture(2); f.plan.pages[0].tree = split(type, f.plan.panels.map(p => leaf(p.id)), [1, 1], slant);
  validatePlan(f.plan, f.atoms, []);
  const [a, b] = compileNameLayout(f.plan).layout.pages[0].slots;
  assert.ok(validQuad(a.points) && validQuad(b.points)); assert.ok(!overlaps(a.points, b.points));
});
for (const [title, mutate] of [
  ['missing atom', f => f.plan.coverage.pop()],
  ['reordered coverage', f => f.plan.coverage.reverse()],
  ['duplicate primary', f => f.plan.panels[1].atomIds = f.plan.panels[0].atomIds],
  ['unknown field', f => f.plan.panels[0].image = 'https://example.invalid'],
  ['unknown character', f => f.plan.panels[0].characterIds = ['not-registered']],
  ['wrong tree order', f => f.plan.pages[0].tree.children.reverse()],
  ['duplicate panel', f => f.plan.panels[1].id = f.plan.panels[0].id],
  ['nonfinite weight', f => f.plan.pages[0].tree.weights[0] = NaN],
  ['zero weight', f => f.plan.pages[0].tree.weights[0] = 0],
  ['weight count', f => f.plan.pages[0].tree.weights.pop()],
  ['splash with neighbours', f => f.plan.panels[0].role = 'splash'],
]) test(`reject ${title}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => validatePlan(f.plan, f.atoms, []));
});
test('silent reaction uses context only, without duplicate primary text', () => {
  const f = fixture(2); const panel = { ...f.plan.panels[0], id: 'reaction', atomIds: [], contextAtomIds: [f.atoms[0].id], role: 'reaction', silentReason: '原稿にある視線の間' };
  f.plan.panels.splice(1, 0, panel); f.plan.pages[0].tree = split('column', f.plan.panels.map(p => leaf(p.id)));
  validatePlan(f.plan, f.atoms, []);
  panel.silentReason = ''; assert.throws(() => validatePlan(f.plan, f.atoms, []), /文脈/);
});
test('quoted text cannot be classified away', () => {
  const f = fixture(1, '# 頭\n\n「省略しない」'); f.plan.coverage[0].presentation = 'visual';
  assert.throws(() => validatePlan(f.plan, f.atoms, []), /原文/);
});
test('legacy positional source and different work are rejected', async () => {
  for (const mutate of [f => f.project.snapshots[0].scenes[0].text += '変化', f => f.file.source.workId = 'other']) {
    const f = await fileFixture(); mutate(f); await assert.rejects(() => bindSource(f.file, f.project));
  }
});
test('source character identity is portable across app-local IDs and follows source reference changes', async () => {
  const f = fixture(1);
  f.snapshot.characters = [{ id: 'hero', name: '勇', description: '短髪' }];
  f.snapshot.references = [{ characterId: 'hero', name: '勇', path: 'hero.jpg', hash: 'b'.repeat(64) }];
  f.project.characters = [{ id: 'local-random-a', name: '勇', description: 'アプリ側表現', hash: 'b'.repeat(64) }];
  const first = await sourceDescriptor(f.project, f.snapshot, f.atoms);
  f.project.characters[0].id = 'local-random-b';
  f.project.characters[0].description = '変えてもファイル来歴には影響しない';
  const second = await sourceDescriptor(f.project, f.snapshot, f.atoms);
  assert.equal(first.referencesHash, second.referencesHash);
  assert.deepEqual(sourceCharacterIdentity(f.snapshot), [{ id: 'hero', name: '勇', description: '短髪', hash: 'b'.repeat(64) }]);
  f.snapshot.references[0].hash = 'c'.repeat(64);
  assert.notEqual((await sourceDescriptor(f.project, f.snapshot, f.atoms)).referencesHash, first.referencesHash);
});
test('different commit with identical source is accepted as rebind, not silently edited', async () => {
  const f = await fileFixture(); f.project.snapshots[0].sha = 'b'.repeat(40); assert.equal((await bindSource(f.file, f.project)).descriptor.commit, 'b'.repeat(40));
});
test('hard text minimum adjusts soft weight or reports infeasible', () => {
  const f = fixture(2); f.plan.pages[0].tree = split('column', f.plan.panels.map(p => leaf(p.id)), [.01, 1]);
  const result = compileNameLayout(f.plan, {}, { p1: { minHeight: 700 } }); assert.ok(result.diagnostics.some(d => d.code === 'weight_adjusted'));
  assert.throws(() => compileNameLayout(f.plan, {}, { p1: { minHeight: 2200 } }), /最小/);
});
test('locked geometry cannot be silently changed', () => {
  const f = fixture(2), old = compileNameLayout(f.plan).layout.pages[0];
  f.plan.pages[0].tree.weights = [6, 4];
  assert.throws(() => compileNameLayout(f.plan, {}, {}, { panelPoints: { p1: old.slots[0].points } }), /固定/);
});
test('malformed/oversized files fail before executing anything', () => {
  for (const raw of ['{', '{}', 'x'.repeat(MAX_BYTES + 1)]) assert.throws(() => parseNameFile(raw));
});
test('bounded card selection, stable prompt and no raw coordinate command', () => {
  const f = fixture(4); assert.equal(CARDS.length, 24);
  const request = buildNamePrompt({ atoms: f.atoms });
  assert.ok(request.cardIds.length <= 18); assert.equal(request.policyVersion, 'name-director/2.0.0');
  assert.equal(request.prompt, buildNamePrompt({ atoms: f.atoms }).prompt);
  assert.throws(() => buildNamePrompt({ atoms: f.atoms, instruction: 'x'.repeat(100001) }), /切り捨て/);
});
test('QA notices are not hard failures or claims of visual acceptance', () => {
  const f = fixture(8); f.plan.pages = f.plan.panels.map((p, i) => ({ ...f.plan.pages[0], id: `pg${i}`, tree: leaf(p.id) }));
  const result = diagnosePlan(f.plan, compileNameLayout(f.plan).layout);
  assert.equal(result.visual, 'not_run'); assert.ok(result.findings.some(x => x.code === 'splash_sequence')); validatePlan(f.plan, f.atoms, []);
  assert.throws(() => validateQA({ findings: [{ pageId: 'unknown', panelIds: [], evidence: 'x', suggestion: 'y' }] }, f.plan));
});
test('deterministic varied tree corpus preserves order and separation', () => {
  for (let i = 1; i <= 128; i++) {
    const f = fixture(4), [a, b, c, d] = f.plan.panels.map(p => leaf(p.id));
    f.plan.pages[0].tree = split(i % 2 ? 'row' : 'column', [split('column', [a, b], [i % 7 + 1, 3]), split('row', [c, d], [2, i % 5 + 1])], [i % 3 + 1, 2]);
    validatePlan(f.plan, f.atoms, []); const result = compileNameLayout(f.plan);
    assert.deepEqual(result.layout.pages[0].slots.map(s => s.panelId), treeLeaves(f.plan.pages[0].tree));
  }
});

test('native schema artifact exactly matches the executable file contract',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {fileSchema}=await import('../contracts/name-plan/schema.mjs');
 assert.deepEqual(JSON.parse(await readFile(new URL('../contracts/name-plan/schema.json',import.meta.url),'utf8')),fileSchema);
});
test('busy action/emotion prompts retain text and mobile readability cards',()=>{
 const f=fixture(1,'# Scene\n\n初めての試合、最後のシュートを打って息を止める。');
 const cards=buildNamePrompt({atoms:f.atoms}).cardIds;
 for(const id of ['text-reserve','scroll-reveal','payoff-link','restraint'])assert.ok(cards.includes(id));
 assert.ok(cards.length<=18);assert.equal(new Set(cards).size,cards.length);
});
