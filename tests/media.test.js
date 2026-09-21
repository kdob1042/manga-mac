import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultImageModelId, defaultVideoModelId, imageModels, videoModels, imageModel, videoConnection } from '../src/media.js';
import { imageRequest, generationSize } from '../src/image-input.js';
import { videoConnectionSupportsEndFrame } from '../src/video.js';

test('the public registry exposes only implemented adapters and freezes defaults', () => {
  assert.equal(defaultImageModelId, 'flux-2-klein-4b-local');
  assert.equal(defaultVideoModelId, 'runway-gen4-5');
  assert.ok(imageModels.length >= 2);
  assert.ok(imageModels.every(model => model.adapter_id === 'media-generation-kit'));
  assert.deepEqual(videoModels.map(model => model.adapter_id), ['runway']);
  assert.throws(() => imageModel('qwen-image'), /未対応/);
  assert.ok(!videoModels.some(model => model.provider === 'fixture' && model.model_id === 'end-frame-v1'), 'test fixtures are not selectable production models');
});

test('selected image model is carried into request and dimensions', () => {
  const selected = imageModel();
  assert.deepEqual(generationSize([1536, 1024], selected.id), [1024, 704]);
  const request = imageRequest({ panel: { prompt: 'scene' }, references: [], original: null, width: 768, height: 768, seed: 5, instruction: '', modelId: selected.id });
  assert.deepEqual(request.media, { registry_id: selected.id, adapter_id: selected.adapter_id, model_id: selected.model_id });
  assert.equal(request.steps, selected.input.steps);
  assert.throws(() => imageRequest({ panel: {}, references: [], width: 1088, height: 768, seed: 5, instruction: '', modelId: selected.id }), /寸法/);
});

test('video selection is explicit and test-only end-frame support stays out of production UI', () => {
  const connection = videoConnection(defaultVideoModelId, 'connection:1');
  assert.deepEqual(connection, { id: 'connection:1', provider: 'runway', model: 'gen4.5', adapter_id: 'runway' });
  assert.equal(videoConnectionSupportsEndFrame(connection), false);
  assert.equal(videoConnectionSupportsEndFrame({ id: 'fixture', provider: 'fixture', model: 'end-frame-v1' }), true);
});

test('both native model definitions produce distinct pinned requests and enforce reference limits', () => {
  const requests = imageModels.map(selected => imageRequest({ panel: { prompt: 'scene' }, references: [], width: 768, height: 768, seed: 5, instruction: '', modelId: selected.id }));
  assert.notEqual(requests[0].media.model_id, requests[1].media.model_id);
  assert.equal(requests[0].media.model_id, imageModels[0].model_id);
  assert.throws(() => imageRequest({ panel: {}, references: Array(9).fill({name:'ref'}), width:768, height:768, seed:5 }), /最大8枚/);
});
