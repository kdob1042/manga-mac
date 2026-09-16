import test from 'node:test';
import assert from 'node:assert/strict';
import { captureUsers, previousCaptureUsers, changedBaseUsers } from '../src/asset-usage.js';

test('MV-11: shared capture traces manga, direct video and artwork-derived video without changing adopted results', () => {
 const project = {
  panels: [{ id: 'p', sceneId: 's', capture_revision: 'new', artwork_revision: 'a', shot_binding: { id: 'binding' } }],
  artworks: [{ id: 'a', capture_revision: 'old' }],
  captures: [{ id: 'old', shot_id: 'binding' }, { id: 'new', parent_revision: 'old', shot_id: 'binding' }],
  videoShots: [{ id: 'v', sceneId: 's', startImage: { kind: 'capture', id: 'old' } }, { id: 'w', sceneId: 's', startImage: { kind: 'artwork', id: 'a' } }, { id: 'adopted', adopted_revision: 'vr', startImage: { kind: 'capture', id: 'other' } }, { id: 'unrelated', startImage: { kind: 'capture', id: 'other' } }],
  videoRevisions: [{ id: 'vr', job_id: 'vj' }], jobs: [{ id: 'vj', manifest: { sourceDependencies: { capture_revision: 'old' } } }],
  shot_batches: [{ status: 'complete', base_session: 'base', checkpoint_hash: 'oldhash', bindings: [{ id: 'binding', panel_id: 'p' }] }]
 };
 const before = structuredClone(project);
 assert.deepEqual(captureUsers(project, ['old']).map(r => r.id), ['p', 'v', 'w', 'adopted']);
 assert.deepEqual(previousCaptureUsers(project, 'new').map(r => r.id), ['p', 'v', 'w', 'adopted']);
 assert.deepEqual(changedBaseUsers(project, { session_id: 'base', state: { checkpoint: { hash: 'newhash' }, dependencies_pinned: true } }).map(r => r.id), ['p', 'v', 'w', 'adopted']);
 assert.deepEqual(changedBaseUsers(project, { session_id: 'other', state: { checkpoint: { hash: 'newhash' }, dependencies_pinned: true } }), []);
 assert.deepEqual(changedBaseUsers(project, { session_id: 'base', state: { checkpoint: { hash: 'oldhash' }, dependencies_pinned: true } }), []);
 assert.deepEqual(project, before);
 // Corrupt history cannot make the read-only report loop forever.
 project.captures[0].parent_revision = 'new';
 assert.equal(previousCaptureUsers(project, 'new').length, 4);
});
