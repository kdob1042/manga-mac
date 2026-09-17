import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../src/core.js';
import { ensureLayout } from '../src/layout.js';
import { defaultLettering } from '../src/lettering.js';
import { produceDraft } from '../src/production.js';

function fixture() {
  const panel = {
    id: 'p',
    sceneId: 's',
    snapshotId: 'source',
    unitIds: ['s:u0'],
    characterIds: [],
    image: 'accepted',
    instructions: [],
    attempts: 0,
  };
  panel.lettering = defaultLettering(panel);
  return ensureLayout({
    ...emptyProject(),
    active: 'source',
    snapshots: [{ id: 'source', scenes: [{ id: 's', text: '本文' }] }],
    panels: [panel],
  });
}
function harness(project) {
  let current = project;
  const unexpected = async () =>
    assert.fail('unexpected generation or AI request');
  return {
    current: () => current,
    commit: async (next) => (current = ensureLayout(next)),
    cancelled: () => false,
    model: {},
    productionMode: 'blender',
    setBusy() {},
    setNotice() {},
    showProof() {},
    stagePanel: unexpected,
    planScene: unexpected,
    generatePanel: unexpected,
    askLLM: unexpected,
    imageOf: unexpected,
    pagePNG: async () => 'proof',
  };
}

test('completed draft resumes without regenerating accepted art, layout or lettering', async () => {
  const project = fixture(),
    args = harness(project),
    before = structuredClone(project);
  let shown;
  await produceDraft({
    ...args,
    showProof: (proof) => {
      shown = proof;
    },
  });
  assert.equal(shown, 'proof');
  assert.deepEqual(args.current(), before);
});

test('cancellation after scene planning keeps the saved draft unchanged', async () => {
  const project = fixture();
  project.panels = [];
  project.layout = ensureLayout({ ...project, layout: undefined }).layout;
  const args = harness(project);
  let stopped = false;
  await produceDraft({
    ...args,
    cancelled: () => stopped,
    planScene: async () => {
      stopped = true;
      return [{ id: 'new' }];
    },
  });
  assert.deepEqual(args.current(), project);
});

test('image failure persists an unknown job before propagating the error', async () => {
  const project = fixture();
  project.panels[0].image = null;
  project.layoutHistory = [{ layout: project.layout }];
  const args = harness(project);
  await assert.rejects(
    () =>
      produceDraft({
        ...args,
        productionMode: 'image',
        generatePanel: async () => {
          throw Error('lost response');
        },
      }),
    /lost response/,
  );
  assert.equal(args.current().jobs.length, 1);
  assert.equal(args.current().jobs[0].status, 'unknown');
  assert.equal(args.current().panels[0].image, null);
});
