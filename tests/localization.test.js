import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnglishUnits, textForPanel, videoWebVTT, currentEnglishLocalization } from '../src/localization.js';

const snapshot = {
  id: 'source@abc:P01',
  scenes: [{ id: 'S01', text: '放課後の図書館。\n\n「ここ、空いてる？」' }],
};
const localization = {
  id: 'source@abc:P01:en',
  snapshot_id: snapshot.id,
  locale: 'en',
  units: [
    { id: 'S01:u0', text: 'After school in the library.' },
    { id: 'S01:u1', text: '“Is this seat free?”' },
  ],
};
const panel = { snapshotId: snapshot.id, sceneId: 'S01', unitIds: ['S01:u1'] };

test('English units must preserve every source ID exactly once and in order', () => {
  const expected = [{ id: 'S01:u0', text: '原文1' }, { id: 'S01:u1', text: '原文2' }];
  assert.deepEqual(validateEnglishUnits({ units: localization.units }, expected), localization.units);
  assert.throws(() => validateEnglishUnits({ units: [localization.units[1], localization.units[0]] }, expected), /段落ID/);
  assert.throws(() => validateEnglishUnits({ units: [localization.units[0]] }, expected), /欠落/);
  assert.throws(() => validateEnglishUnits({ units: [{ id: 'S01:u0', text: '' }, localization.units[1]] }, expected), /本文/);
});

test('manga switches only the lettering text and preserves source snapshot', () => {
  assert.equal(textForPanel(panel, snapshot), '「ここ、空いてる？」');
  assert.equal(textForPanel(panel, snapshot, localization), '“Is this seat free?”');
  assert.equal(snapshot.scenes[0].text, '放課後の図書館。\n\n「ここ、空いてる？」');
});

test('stale English localization is rejected instead of falling back to Japanese', () => {
  assert.throws(() => textForPanel(panel, snapshot, { ...localization, snapshot_id: 'old' }), /現在の原作/);
  assert.equal(currentEnglishLocalization({ localizations: [localization] }, snapshot), localization);
  assert.equal(currentEnglishLocalization({ localizations: [localization] }, { ...snapshot, id: 'new' }), null);
});

test('video WebVTT uses the same unit translations as manga', () => {
  const shots = [
    { id: 'shot-1', snapshotId: snapshot.id, sceneId: 'S01', unitIds: ['S01:u0'], start_ms: 0, end_ms: 2500 },
    { id: 'shot-2', snapshotId: snapshot.id, sceneId: 'S01', unitIds: ['S01:u1'], start_ms: 2500, end_ms: 5000 },
  ];
  const vtt = videoWebVTT(shots, [snapshot], localization);
  assert.match(vtt, /00:00:00\.000 --> 00:00:02\.500\nAfter school in the library\./);
  assert.match(vtt, /00:00:02\.500 --> 00:00:05\.000\n“Is this seat free\?”/);
  assert.doesNotMatch(vtt, /ここ、空いてる/);
});
