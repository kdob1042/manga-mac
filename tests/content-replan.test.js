import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../src/core.js';
import { ensureLayout } from '../src/layout.js';
import { confirmThroughPage } from '../src/confirmation.js';
import { undoEdit } from '../src/edit-commands.js';
import {
  adoptContentReplan,
  loadContentReplan,
  proposeContentReplan,
  saveContentReplan,
} from '../src/content-replan.js';

function fixture() {
  const scenes = [{ id: 's', text: Array.from({ length: 6 }, (_, i) => `本文${i}。`).join('\n\n') }, { id: 'out', text: '対象外。' }];
  const panels = Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`,
    sceneId: 's',
    snapshotId: 'source',
    unitIds: [`s:u${i}`],
    prompt: `shot-${i}`,
    characterIds: [],
    image: `art-${i}`,
    status: 'review',
    lettering: { mode: 'caption', boxes: [] },
    instructions: [],
    attempts: 0,
  }));
  panels.push({ id: 'outside', sceneId: 'out', snapshotId: 'source', unitIds: ['out:u0'], prompt: 'outside', characterIds: [], image: 'outside-art', instructions: [], attempts: 0 });
  return ensureLayout({ ...emptyProject(), active: 'source', snapshots: [{ id: 'source', sha: 'sha', scenes }], panels });
}

async function changedCandidate(project, jobId = 'job-1') {
  return proposeContentReplan(project, ['s'], '会話をまとめる', async (prompt) => {
    const input = JSON.parse(prompt);
    const units = input.mutableUnits;
    return JSON.stringify({
      reason: '冒頭の二unitを一つのコマへまとめる',
      panels: [
        { unitIds: units.slice(0, 2).map((unit) => unit.id), prompt: 'combined', characterIds: [] },
        ...units.slice(2).map((unit, i) => ({ unitIds: [unit.id], prompt: `shot-${i + 2}`, characterIds: [] })),
      ],
    });
  }, jobId);
}

test('content replan validates source order, retains exact panels, and marks only changed panels for redraw', async () => {
  const project = fixture(), before = structuredClone(project), candidate = await changedCandidate(project);
  assert.equal(candidate.summary.changed, true);
  assert.equal(candidate.scenes[0].redrawPanelIds.length, 1);
  assert.deepEqual(candidate.scenes[0].retainedPanelIds, ['p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(project, before);
  const adopted = await adoptContentReplan(project, candidate);
  assert.equal(adopted.panels.find((panel) => panel.id === 'p2').image, 'art-2');
  assert.equal(adopted.panels.find((panel) => panel.id === candidate.scenes[0].redrawPanelIds[0]).image, null);
  assert.equal(adopted.panels.find((panel) => panel.id === 'outside').image, 'outside-art');
  assert.equal(adopted.history.at(-1).panels.find((panel) => panel.id === 'p0').image, 'art-0');
  assert.deepEqual(adopted.layout.pages[0].slots.map((slot) => slot.points), project.layout.pages[0].slots.map((slot) => slot.points));
});

test('content candidates persist without image copies, reload, and reject stale artwork', async () => {
  const project = fixture(), candidate = await changedCandidate(project, 'job-2');
  const saved = await saveContentReplan(project, candidate), job = saved.jobs.at(-1);
  assert.equal(JSON.stringify(job).includes('art-0'), false);
  const reopened = await loadContentReplan(JSON.parse(JSON.stringify(saved)), job.id);
  assert.equal(reopened.reason, candidate.reason);
  await assert.rejects(() => loadContentReplan({ ...saved, panels: saved.panels.map((panel) => panel.id === 'p2' ? { ...panel, image: 'changed' } : panel) }, job.id), /原稿が変わった/);
});

test('invalid response is rejected without changing the current draft', async () => {
  const project = fixture(), before = structuredClone(project);
  await assert.rejects(() => proposeContentReplan(project, ['s'], '壊れた案', async () => JSON.stringify({ reason: '欠落', panels: [{ unitIds: ['s:u0'], prompt: 'bad', characterIds: [] }] })), /原文の欠落/);
  assert.deepEqual(project, before);
});

test('confirmed prefix remains byte-identical and content Undo/Redo restores the whole boundary', async () => {
  let project = fixture();
  project = confirmThroughPage(project, 0);
  const before = structuredClone(project);
  const beforePrefix = structuredClone(project.layout.pages[0]), candidate = await changedCandidate(project, 'job-3');
  assert.equal(candidate.scenes[0].protectedPanelIds.length, 4);
  project = await adoptContentReplan(project, candidate);
  assert.deepEqual(project.layout.pages[0], beforePrefix);
  const undone = undoEdit(project);
  assert.deepEqual(undone.panels, before.panels);
  assert.deepEqual(undone.layout, before.layout);
  const redone = undoEdit(undone, true);
  assert.deepEqual(redone.panels, project.panels);
  assert.deepEqual(redone.layout, project.layout);
});
