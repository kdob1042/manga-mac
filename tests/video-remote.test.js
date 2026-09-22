import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreVideoResults } from '../src/video-remote.js';
import { emptyProject } from '../src/core.js';

const artifact = { artifact_id: 'a'.repeat(64), hash: 'a'.repeat(64), mime: 'video/mp4', size: 1838 };
const fixture = remote => ({ panels: [{ id: 'p' }], history: [{ panels: [] }], videoShots: [{ id: 'v', adopted_revision: null }], videoRevisions: [], videoHistory: [], jobs: [{ id: 'j', kind: 'video', scope: { type: 'videoShot', id: 'v' }, status: 'unknown', input_hash: 'h', base_revision: null, remote }] });

test('empty project exposes shared artwork and video collections before first save', () => {
  const p = emptyProject();
  assert.deepEqual(p.artworks, []);
  assert.deepEqual(restoreVideoResults(p), p);
});

test('local restart never bills credits or replays inference; saved artifact becomes one candidate', () => {
  const p = fixture({ provider: 'ltx-mlx', status: 'unknown' });
  p.jobs[0].manifest = { connection: { id: 'local', provider: 'ltx-mlx', model: 'ltx-2.5' } };
  p.jobs[0].cost = { kind: 'local', amount: null, currency: null };
  const unknown = restoreVideoResults(p);
  assert.equal(unknown.jobs[0].status, 'unknown');
  assert.equal(unknown.jobs[0].cost.kind, 'local');
  unknown.jobs[0].remote = { provider: 'ltx-mlx', status: 'SUCCEEDED', artifact };
  const candidate = restoreVideoResults(unknown);
  assert.equal(candidate.jobs[0].status, 'candidate');
  assert.equal(candidate.jobs[0].cost.kind, 'local');
  assert.equal(candidate.videoRevisions.length, 1);
  assert.equal(candidate.videoShots[0].adopted_revision, null);
  assert.deepEqual(restoreVideoResults(candidate), candidate);
});

test('MV-06 restart restores submitted task state and reserved cost without producing a new job', () => {
  for (const status of ['PENDING', 'THROTTLED', 'RUNNING', 'FAILED', 'CANCELLED', 'unknown', 'cancel_requested', 'SUCCEEDED']) {
    const p = fixture({ status, task_id: 'stored-task', reserved_credits: 60 });
    const next = restoreVideoResults(p);
    assert.equal(next.jobs.length, 1);
    assert.equal(next.jobs[0].remote.task_id, 'stored-task');
    assert.equal(next.jobs[0].cost.reserved, 60);
    assert.deepEqual(next.panels, p.panels);
    assert.deepEqual(next.history, p.history);
    assert.equal(next.videoShots[0].adopted_revision, null);
    assert.deepEqual(restoreVideoResults(next), next);
  }
});

test('MV-07 native collection survives UI crash, attaches exactly once and remains a candidate', () => {
  const p = fixture({ status: 'SUCCEEDED', reserved_credits: 60, artifact });
  const next = restoreVideoResults(p);
  assert.equal(next.videoRevisions.length, 1);
  assert.equal(next.jobs[0].status, 'candidate');
  assert.equal(next.jobs[0].output_revision, next.videoRevisions[0].id);
  assert.equal(next.videoShots[0].adopted_revision, null);
  assert.deepEqual(restoreVideoResults(JSON.parse(JSON.stringify(next))), next);
  const stopped = fixture({ status: 'SUCCEEDED', artifact }); stopped.jobs[0].status = 'abandoned';
  assert.equal(restoreVideoResults(stopped).jobs[0].status, 'candidate');
  const abandoned = fixture({ status: 'unknown', reserved_credits: 60 }); abandoned.jobs[0].status = 'abandoned';
  assert.deepEqual(restoreVideoResults(abandoned), abandoned);
});

test('unknown provider states and corrupted output metadata cannot become successful candidates', () => {
  assert.throws(() => restoreVideoResults(fixture({ status: 'NEW_UNKNOWN_STATE' })));
  assert.throws(() => restoreVideoResults(fixture({ status: 'SUCCEEDED', artifact: { ...artifact, hash: 'wrong' } })));
});

test('MV-06/07: explicit service check resolves lost cancellation or expired output without cancelling, refunding or resubmitting', async () => {
 const { resolveVideoTask } = await import('../src/video-remote.js');
 for (const status of ['unknown', 'submitted', 'cancel_requested', 'output_pending']) {
  const remote = { status: 'cancel_requested', task_id: 'task', reserved_credits: 60, last_poll: 123 };
  const p = { jobs: [{ id: 'job', scope: { type: 'videoShot', id: 'v' }, status, remote }], videoShots: [{ id: 'v', adopted_revision: 'old' }], videoRevisions: [] };
  assert.throws(() => resolveVideoTask(p, 'job', false));
  const next = resolveVideoTask(p, 'job', true);
  assert.equal(next.jobs[0].status, 'abandoned');
  assert.deepEqual(next.jobs[0].remote, remote); assert.deepEqual(next.videoShots, p.videoShots);
  assert.equal(restoreVideoResults(next).jobs[0].status, 'abandoned');
  assert.throws(() => resolveVideoTask(next, 'job', true));
  assert.throws(() => resolveVideoTask({ ...p, jobs: [{ ...p.jobs[0], output_revision: 'saved' }] }, 'job', true));
 }
});
