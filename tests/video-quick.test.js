import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateProject } from '../src/revisions.js';
import { draftPanelVideoMotion, quietPanelMotion } from '../src/video-plan.js';
import { panelVideoDefaults } from '../src/video-batch.js';
import { runPanelVideos } from '../src/video-quick.js';

const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url)));
async function fixture(count = 2) {
  const project = await migrateProject(legacy);
  const base = project.panels[0], artwork = project.artworks.find(item => item.id === base.artwork_revision);
  project.panels = Array.from({ length: count }, (_, i) => ({ ...structuredClone(base), id: `panel-${i}`, artwork_revision: `art-${i}` }));
  project.artworks = project.panels.map((panel, i) => ({ ...structuredClone(artwork), id: `art-${i}`, panel: structuredClone(panel) }));
  project.jobs = [];
  return project;
}

test('motion draft uses the assigned source and only sends the image for a vision connection', async () => {
  const p = await fixture(1), panel = p.panels[0];
  assert.equal(await draftPanelVideoMotion(p, panel, null), quietPanelMotion);
  for (const visualEditing of [false, true]) {
    const result = await draftPanelVideoMotion(p, panel, { connectionId: 'llm', visualEditing }, async (_, request) => {
      assert.ok(request.prompt.includes(panel.prompt));
      assert.ok(request.prompt.includes('source'));
      assert.equal(request.purpose, visualEditing ? 'vision' : 'plan');
      assert.deepEqual(request.images, visualEditing ? [panel.image] : []);
      return JSON.stringify({ motion: ' Small natural motion. ' });
    });
    assert.equal(result, 'Small natural motion.');
  }
});

test('quick generation freezes each artwork and saves its Job before submitting once', async () => {
  let saved = await fixture(), submissions = [];
  const ids = saved.panels.map(panel => panel.id), modelId = 'runway-gen4-turbo';
  const options = { panelIds: ids, modelId, connectionId: 'connection', motionConnection: null,
    getProject: () => saved, commit: async next => { saved = structuredClone(next); }, refresh: async () => {},
    draftMotion: async (_, panel) => `Move ${panel.id} subtly`,
    submit: async job => {
      assert.equal(saved.jobs.find(item => item.id === job.id)?.input_hash, job.input_hash);
      submissions.push(job.scope.id);
      saved.jobs.find(item => item.id === job.id).status = 'submitted';
    },
  };
  const expected = ids.map(id => panelVideoDefaults(saved, id, modelId));
  assert.ok(expected.every(item => item.valid && item.ratio === '960:960'));
  await runPanelVideos(options);
  assert.equal(saved.videoShots.length, 2);
  assert.deepEqual(saved.videoShots.map(item => item.prompt), ids.map(id => `Move ${id} subtly`));
  assert.deepEqual(saved.videoShots.map(item => item.startImage.hash), expected.map(item => item.artwork.hash));
  assert.equal(submissions.length, 2);
  await assert.rejects(runPanelVideos({ ...options, panelIds: [], batchId: saved.videoShots[0].batchId }), /未送信/);
  assert.equal(submissions.length, 2);
});

test('invalid second panel or failed motion draft never saves or sends a partial batch', async () => {
  let saved = await fixture(), submissions = 0;
  const options = { panelIds: saved.panels.map(item => item.id), modelId: 'runway-gen4-turbo', connectionId: 'connection',
    getProject: () => saved, commit: async next => { saved = next; }, refresh: async () => {},
    submit: async () => { submissions++; }, draftMotion: async (_, panel) => {
      if (panel.id === 'panel-1') throw Error('motion unavailable');
      return 'small motion';
    },
  };
  await assert.rejects(runPanelVideos(options), /motion unavailable/);
  assert.equal(saved.videoShots.length, 0); assert.equal(submissions, 0);
  saved.panels[1].artwork_revision = null;
  await assert.rejects(runPanelVideos(options), /採用済み作画/);
  assert.equal(saved.jobs.length, 0); assert.equal(submissions, 0);
});
