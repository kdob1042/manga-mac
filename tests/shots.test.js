import test from 'node:test';
import assert from 'node:assert/strict';
import { planShots, attachShots, bindCharacter, recordCapture } from '../src/shots.js';
import { imageHash, migrateProject } from '../src/revisions.js';
const hash = 'a'.repeat(64);
const base = { session_id: 'base', revision: 2, state: { dependencies_pinned: true, checkpoint: { hash } } };
function fixture() { return { version: 2, active: 'source', snapshots: [], characters: [{ id: 'A' }], jobs: [], artworks: [], history: [], panels: [0,1,2,3].map(i => ({ id: `p${i}`, snapshotId: 'source', characterIds: ['A'], image: null, instructions: [] })) }; }
function prepared() {
 let p = fixture(); const batch = planShots(p, p.panels.map(p => p.id), base);
 p.shot_batches = [batch];
 const sessions = batch.bindings.map(b => ({ session_id: b.id, revision: 0, state: base.state }));
 return attachShots(p, batch, sessions);
}
test('SCOPE-01: four bindings share a fixed pack but have independent session IDs; retry cannot duplicate', () => {
 const p = fixture(), batch = planShots(p, p.panels.map(p => p.id), base); p.shot_batches = [batch];
 assert.throws(() => planShots(p, ['p0'], base));
 const sessions = batch.bindings.map(b => ({ session_id: b.id, state: base.state }));
 const next = attachShots(p, batch, sessions);
 assert.equal(new Set(next.panels.map(p => p.shot_binding.session_id)).size, 4);
 assert.equal(new Set(next.panels.map(p => p.shot_binding.origin_hash)).size, 1);
 assert.throws(() => attachShots(next, batch, sessions));
 assert.throws(() => attachShots(p, batch, sessions.slice(0,3)));
 assert.throws(() => attachShots({ ...p, panels: p.panels.map(p => ({ ...p, snapshotId: 'new' })) }, batch, sessions));
});
test('CharacterBinding points only to an existing Blender object and does not alter other panels', () => {
 const p = prepared(), panel = p.panels[1];
 const session = { session_id: panel.shot_binding.session_id, state: { checkpoint: { hash }, state: { scene: 'Stage' }, scenes: [{ name: 'Stage', objects: ['Actor'] }] } };
 const next = bindCharacter(p, panel.id, 'A', 'Actor', session);
 assert.equal(next.character_bindings[0].asset_ref.object, 'Actor');
 assert.deepEqual(next.panels, p.panels);
 assert.throws(() => bindCharacter(p, panel.id, 'A', 'missing', session));
 assert.throws(() => bindCharacter(p, 'p0', 'A', 'Actor', session));
});
test('CAPTURE-01/RETAKE-01: a verified retake records provenance and preserves old artwork and other panels', async () => {
 const p = prepared(), panel = p.panels[1]; panel.image = 'old-artwork';
 const preview = 'data:image/png;base64,iVBORw0KGgo=';
 const response = { session_id: panel.shot_binding.session_id, request_id: 'request-1', preview, state: { dependencies_pinned: true, checkpoint: { file: 'checkpoint.blend', hash }, image: { file: 'capture.png', hash: await imageHash(preview) }, state: { frame: 1, resolution: [768, 512] }, blender_version: [4,5,13] } };
 const next = await recordCapture(p, panel.id, response);
 assert.equal(next.panels[1].image, 'old-artwork'); assert.equal(p.panels[1].capture_revision, null);
 assert.deepEqual(next.panels[0], p.panels[0]); assert.deepEqual(next.history[0].panels, p.panels);
 assert.equal(next.captures[0].settings.resolution[1], 512);
 assert.equal((await recordCapture(next, panel.id, response)).captures.length, 1);
 await assert.rejects(recordCapture(p, 'p0', response));
 await assert.rejects(recordCapture(p, panel.id, { ...response, preview: 'data:image/png;base64,AAAA' }));
 await assert.rejects(recordCapture(p, panel.id, { ...response, state: { ...response.state, dependencies_pinned: false } }));
});
test('legacy migration retains new bindings and capture history across reload', async () => {
 const p = prepared(); const loaded = await migrateProject(p, true);
 assert.deepEqual(loaded.panels[0].shot_binding, p.panels[0].shot_binding);
 assert.deepEqual(loaded.shot_batches, p.shot_batches);
});
