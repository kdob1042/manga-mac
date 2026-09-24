import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSceneAsset, sceneAssets } from '../src/scene-assets.js';

const hash = 'a'.repeat(64);
const descriptor = { name: 'バスケットボール', kind: 'prop', source: 'import', file: `${hash}.glb`, hash, bytes: 128 };

test('scene asset reuse is content-addressed and survives a project clone', () => {
  const registered = registerSceneAsset({ jobs: [] }, descriptor);
  assert.equal(registered.asset.id, hash);
  assert.deepEqual(sceneAssets(structuredClone(registered.project)), [registered.asset]);
  const same = registerSceneAsset(registered.project, descriptor);
  assert.equal(same.project, registered.project);
  assert.equal(sceneAssets(same.project).length, 1);
});

test('scene assets reject traversal, unverified references and conflicting metadata', () => {
  assert.throws(() => registerSceneAsset({}, { ...descriptor, file: '../model.glb' }), /登録情報/);
  assert.throws(() => registerSceneAsset({}, { ...descriptor, hash: 'not-a-hash' }), /登録情報/);
  assert.throws(() => registerSceneAsset({ sceneAssets: [{ ...descriptor, id: hash, bytes: 256 }] }, descriptor), /衝突/);
});
