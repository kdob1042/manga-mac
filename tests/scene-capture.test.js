import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSceneCapture, verifySceneCapture } from '../src/scene-capture.js';
import { imageRequest } from '../src/image-input.js';

const pngHeader = Buffer.alloc(36);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader);
pngHeader.writeUInt32BE(13, 8);
pngHeader.write('IHDR', 12);
pngHeader.writeUInt32BE(768, 16);
pngHeader.writeUInt32BE(512, 20);
const png = `data:image/png;base64,${pngHeader.toString('base64')}`;
const scene = { schemaVersion: 1, objects: [{ id: 'actor', assetId: 'verified' }], camera: { fov: 45 } };
const sceneAssets = [{ id: 'verified', hash: 'a'.repeat(64) }];

test('capture records immutable original and only changes the selected panel', async () => {
  const before = { panels: [{ id: 'p', snapshotId: 'script1', scene3d: scene, image: 'accepted' }, { id: 'other', image: 'untouched' }], sceneAssets, captures: [], jobs: [], history: [] };
  const after = await recordSceneCapture(before, 'p', png, 768, 512);
  assert.equal(after.panels[0].image, 'accepted');
  assert.equal(after.panels[1], before.panels[1]);
  assert.equal(before.captures.length, 0);
  assert.equal(after.captures[0].original, png);
  assert.equal(await verifySceneCapture(after.panels[0], after.captures[0]), png);
  assert.deepEqual(after.jobs, []);
  const older = await recordSceneCapture(after, 'p', png, 768, 512);
  assert.equal(older.captures[1].parent_revision, after.captures[0].id);
  assert.equal(older.captures[0].original, png);
});

test('modified scene or altered image cannot be passed to image generation', async () => {
  const base = { panels: [{ id: 'p', snapshotId: 'script1', scene3d: scene }], sceneAssets, captures: [] };
  const captured = await recordSceneCapture(base, 'p', png, 768, 512);
  const panel = captured.panels[0], capture = captured.captures[0];
  await assert.rejects(verifySceneCapture({ ...panel, scene3d: { ...scene, camera: { fov: 80 } } }, capture), /撮り直し/);
  await assert.rejects(verifySceneCapture(panel, { ...capture, original: `${png}tamper` }), /撮り直し/);
  await assert.rejects(recordSceneCapture(base, 'p', 'data:image/jpeg;base64,AAAA', 768, 512), /PNG/);
});

test('the saved render bytes, not just capture metadata, become the image model input', async () => {
  const base = { panels: [{ id: 'p', snapshotId: 'script1', scene3d: scene, prompt: 'two players' }], sceneAssets, captures: [] };
  const captured = await recordSceneCapture(base, 'p', png, 768, 512);
  const panel = captured.panels[0], capture = captured.captures[0];
  const original = await verifySceneCapture(panel, capture);
  const request = imageRequest({ panel, references: [], original, originalHash: capture.image.hash,
    width: 768, height: 512, seed: 1, instruction: '', capture });
  assert.equal(request.original, png);
  assert.equal(request.original_hash, capture.image.hash);
  assert.equal(request.capture.id, capture.id);
  assert.equal(request.capture.checkpoint_hash, capture.scene_hash);
});
