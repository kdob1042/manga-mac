import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { emptyProject } from '../src/core.js';
import { ensureLayout, template } from '../src/layout.js';
import { validateProposal, layoutBase, savedLayoutCandidates, layoutCandidateRange, adoptSavedLayoutCandidate, discardLayoutCandidate } from '../src/layout-ai.js';
globalThis.crypto ??= webcrypto;

function fixture() {
  return ensureLayout({ ...emptyProject(), active: 'source', panels: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, sceneId: 'scene', snapshotId: 'source', unitIds: [], characterIds: [], prompt: 'panel' })) });
}
function candidateJob(project, id, index = 1) {
  const page = structuredClone(project.layout.pages[index]);
  page.slots[0].points[0][0] += .02;
  return { id, kind: 'layout', status: 'candidate', input_hash: layoutBase(project), layout_candidate: { ...validateProposal(project, { reason: id, pages: [page] }, [page.id]), jobId: id } };
}

test('all three saved attempts stay selectable and resolving one preserves the other saved work', () => {
  const project = fixture();
  project.jobs = ['one', 'two', 'three'].map(id => candidateJob(project, id));
  project.jobs[1].layout_candidate.jobId = 'one'; // Stored job identity remains authoritative.
  project.jobs.push({ id: 'latest-unrelated', kind: 'edit_proposal', status: 'candidate' });
  project.history.push({ label: 'latest unrelated history' });
  assert.deepEqual(savedLayoutCandidates(project).map(value => value.jobId), ['one', 'two', 'three']);
  const before = JSON.stringify(project);
  const next = adoptSavedLayoutCandidate(project, 'two');
  assert.equal(next.jobs.find(job => job.id === 'two').status, 'complete');
  assert.equal(next.jobs.find(job => job.id === 'one').status, 'candidate');
  assert.deepEqual(next.jobs.at(-1), project.jobs.at(-1));
  assert.deepEqual(next.history, project.history);
  assert.deepEqual(next.layout.pages[0], project.layout.pages[0]);
  assert.deepEqual(next.layout.pages[2], project.layout.pages[2]);
  assert.notDeepEqual(next.layout.pages[1], project.layout.pages[1]);
  assert.equal(JSON.stringify(project), before);
});

test('discarding persists the resolution without deleting artwork, layout or unrelated candidates', () => {
  const project = fixture();
  project.jobs = [candidateJob(project, 'discard'), candidateJob(project, 'keep', 0)];
  const next = JSON.parse(JSON.stringify(discardLayoutCandidate(project, 'discard')));
  assert.equal(next.jobs[0].status, 'abandoned');
  assert.deepEqual(savedLayoutCandidates(next).map(value => value.jobId), ['keep']);
  assert.deepEqual(next.layout, project.layout);
  assert.deepEqual(next.panels, project.panels);
  assert.throws(() => adoptSavedLayoutCandidate(next, 'discard'), /解決済み/);
});

test('old-base proposals remain disposable but cannot overwrite the latest layout', () => {
  const project = fixture();
  project.jobs = [candidateJob(project, 'old')];
  project.layout.pages[0].slots[0].points[0][0] += .01;
  const before = JSON.stringify(project);
  assert.throws(() => adoptSavedLayoutCandidate(project, 'old'), /変更/);
  assert.equal(JSON.stringify(project), before);
  assert.equal(discardLayoutCandidate(project, 'old').jobs[0].status, 'abandoned');
});

test('preview range contains only replacement pages and retains its original page identity after navigation', () => {
  const project = fixture(), original = project.layout.pages[1];
  const ids = original.slots.map(slot => slot.panelId);
  const pages = [{ id: 'replacement-a', slots: template(2, ids.slice(0, 2)) }, { id: 'replacement-b', slots: template(2, ids.slice(2)) }];
  const candidate = validateProposal(project, { reason: 'split middle page', pages }, [original.id]);
  const range = layoutCandidateRange(candidate);
  assert.equal(range.first, 1);
  assert.equal(range.count, 2);
  assert.equal(range.label, '2ページ');
  assert.deepEqual(range.pages, candidate.layout.pages.slice(1, 3));
  assert.equal(range.pages.flatMap(page => page.slots).length, 4);
});

test('damaged saved proposals remain discardable without breaking valid candidates', () => {
  const project = fixture();
  project.jobs = [candidateJob(project, 'valid'), { id: 'broken', kind: 'layout', status: 'candidate', layout_candidate: { base: '{', scope: null } }];
  const candidates = savedLayoutCandidates(project);
  assert.equal(candidates[0].range.label, '2ページ');
  assert.match(candidates[1].invalidReason, /確認できません/);
  assert.deepEqual(candidates[1].scope, []);
  assert.throws(() => adoptSavedLayoutCandidate(project, 'broken'), /確認できません/);
  assert.deepEqual(savedLayoutCandidates(discardLayoutCandidate(project, 'broken')).map(candidate => candidate.jobId), ['valid']);
});
