import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedScenes, safePath, sourceUnits, validatePlan, compositePixels, sourceForPanel, affectedScenes, revise } from '../src/core.js';
test('manifest episode order wins over names and array order', () => {
 const m = { episodes: [{ id: 'P12', scene_ids: ['P12-03', 'P11-01a'] }], scenes: [{ id: 'P11-01a', path: 'manuscript/after.md' }, { id: 'P12-03', path: 'manuscript/final.md' }] };
 assert.deepEqual(orderedScenes(m, 'P12').map(s => s.id), ['P12-03', 'P11-01a']);
 assert.throws(() => orderedScenes({ ...m, scenes: [m.scenes[0]] }, 'P12'));
});
test('source paths cannot escape or inject query parameters', () => {
 for (const p of ['../token', '/etc/passwd', 'a/../b', 'a?ref=main', 'a%2fb', 'a\\b']) assert.throws(() => safePath(p));
});
test('model must cover original units exactly once in order', () => {
 const units = sourceUnits('s', '# Header\n\n「好き」\n\n彼は黙った。\n\n「嫌い」');
 const panels = units.map(u => ({ unitIds: [u.id], prompt: 'A manga panel', characterIds: [] }));
 assert.equal(validatePlan({ panels }, units, []).length, 3);
 for (const ps of [[...panels].reverse(), panels.slice(1), [...panels, panels[0]]]) assert.throws(() => validatePlan({ panels: ps }, units, []));
 assert.throws(() => validatePlan({ panels: [{ ...panels[0], characterIds: ['invented'] }, ...panels.slice(1)] }, units, []));
});
test('rendered text is original source, never model output', () => {
 const text = '「好き、だよ」\n\n  話者が振り返った。';
 const units = sourceUnits('s', text);
 assert.equal(sourceForPanel({ sceneId: 's', unitIds: units.map(u => u.id) }, { scenes: [{ id: 's', text }] }), text);
});
test('every RGBA byte outside mask is unchanged including alpha', () => {
 const a = Uint8ClampedArray.from({ length: 400 }, (_, i) => i % 256), b = new Uint8ClampedArray(400).fill(42), mask = new Uint8Array(100); mask[44] = 1;
 const out = compositePixels(a, b, mask);
 for (let i = 0; i < 400; i++) assert.equal(out[i], Math.floor(i / 4) === 44 ? 42 : a[i]);
 assert.notEqual(out, a);
});
test('setting changes invalidate affected scene evaluation, unchanged scenes survive', () => {
 const a = { settings: [{ text: 'uniform' }], scenes: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] };
 assert.deepEqual(affectedScenes(a, { ...a, scenes: [{ id: 'a', text: 'changed' }, a.scenes[1]] }), ['a']);
 assert.deepEqual(affectedScenes(a, { ...a, settings: [{ text: 'new uniform' }] }), ['a', 'b']);
});
test('undo retains exact previous images and unaffected panels', () => {
 const p = { panels: [{ id: 'a', image: 'original' }, { id: 'b', image: 'unchanged' }], history: [] };
 const next = revise(p, [{ id: 'a', image: 'changed' }, p.panels[1]], 'smile');
 assert.deepEqual(next.history[0].panels, p.panels); assert.equal(next.panels[1], p.panels[1]);
});
