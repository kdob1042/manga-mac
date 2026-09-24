import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../src/core.js';
import { beginTripoJob, TRIPO_MODEL } from '../src/tripo.js';

const image = 'data:image/png;base64,AQID';
const imageHash = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

test('Tripo job freezes provider, model and selected reference hash', () => {
  const project = {
    ...emptyProject(),
    active: 'snapshot-1',
    characters: [{ id: 'character-1', name: 'A', version: 3, image, hash: imageHash }],
  };
  const next = beginTripoJob(project, { characterId: 'character-1', prompt: '全身モデル' });
  const job = next.jobs[0];
  assert.equal(job.kind, 'tripo_model');
  assert.deepEqual(job.scope, { type: 'tripoModel', id: job.id });
  assert.equal(job.manifest.provider, 'tripo');
  assert.equal(job.manifest.model, TRIPO_MODEL);
  assert.equal(job.manifest.source.snapshot_id, 'snapshot-1');
  assert.equal(job.manifest.image.hash, imageHash);
});

test('Tripo job rejects a missing or non-image reference', () => {
  const project = { ...emptyProject(), characters: [{ id: 'character-1', hash: imageHash }] };
  assert.throws(() => beginTripoJob(project, { characterId: 'character-1' }), /参照画像/);
  const badHash = { ...project, characters: [{ id: 'character-1', image, hash: 'bad' }] };
  assert.throws(() => beginTripoJob(badHash, { characterId: 'character-1' }), /参照画像/);
});

test('Tripo can request a missing prop from a pinned image without a character', () => {
  const project = { ...emptyProject(), active: 'snapshot-1' };
  const next = beginTripoJob(project, { kind: 'prop', name: 'バスケットボール', reference: { image, hash: imageHash } });
  assert.equal(next.jobs[0].manifest.source.asset_kind, 'prop');
  assert.equal(next.jobs[0].manifest.source.asset_name, 'バスケットボール');
  assert.equal(next.jobs[0].manifest.image.hash, imageHash);
  assert.throws(() => beginTripoJob(project, { kind: 'environment', reference: { image, hash: imageHash } }), /素材名/);
});
