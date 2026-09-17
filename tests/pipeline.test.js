import test from 'node:test';
import assert from 'node:assert/strict';
import { planScene } from '../src/pipeline.js';

test('a scene without source text produces an image-only panel', async () => {
  const calls = [];
  const panels = await planScene(
    { id: 'visual', text: '', design: 'A quiet room at dusk.' },
    { id: 'snapshot', settings: [] },
    [],
    {},
    async (_model, request) => {
      calls.push(JSON.parse(request.prompt));
      return JSON.stringify({ panels: [{ unitIds: [], prompt: 'A quiet room at dusk.', characterIds: [] }] });
    },
  );
  assert.equal(calls[0].units.length, 0);
  assert.match(calls[0].task, /画像だけのコマ/);
  assert.deepEqual(panels[0].unitIds, []);
  assert.equal(panels[0].image, null);
});

test('the planner accepts an image-only panel alongside source-text panels', async () => {
  const source = '説明文。';
  const units = [{ id: 'visual:u0', text: source }];
  const panels = await planScene(
    { id: 'visual', text: source, design: '' },
    { id: 'snapshot', settings: [] },
    [],
    {},
    async () => JSON.stringify({ panels: [
      { unitIds: [], prompt: 'A silent establishing panel.', characterIds: [] },
      { unitIds: [units[0].id], prompt: 'A panel with source text.', characterIds: [] },
    ] }),
  );
  assert.deepEqual(panels.map(panel => panel.unitIds), [[], ['visual:u0']]);
});
