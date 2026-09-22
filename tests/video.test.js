import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProject, imageHash } from '../src/revisions.js';
import { createVideoShot, videoManifest, beginVideoJob, videoJobIsCurrent, resolveStartImage, collectVideoResult, adoptVideoCandidate, undoVideo, validateVideoFrame } from '../src/video.js';

const legacy = JSON.parse(await readFile(new URL('./fixtures/legacy-v1.json', import.meta.url)));
const connection = { id: 'test-only', provider: 'runway', model: 'gen4.5' };
const localConnection = { id: 'local-test', provider: 'ltx-mlx', model: 'ltx-2.5' };
async function fixture() {
  const p = await migrateProject(legacy), panel = p.panels[0], artwork = p.artworks.find(a => a.id === panel.artwork_revision);
  return createVideoShot(p, { snapshotId: panel.snapshotId, sceneId: panel.sceneId, unitIds: panel.unitIds,
    characterIds: panel.characterIds, startImage: { kind: 'artwork', id: artwork.id, hash: artwork.hash },
    prompt: 'A slow camera push. No sound.', duration: 5, ratio: '960:960' });
}

test('local MLX uses pinned start image and local cost; provider dimensions do not silently change', async () => {
  const p = await fixture(), shot = p.videoShots[0];
  await assert.rejects(videoManifest(p, shot, localConnection), /寸法/);
  shot.ratio = '512:512';
  const started = await beginVideoJob(p, shot.id, localConnection);
  assert.equal(started.job.cost.kind, 'local');
  assert.equal(started.job.manifest.connection.provider, 'ltx-mlx');
  assert.equal(started.job.manifest.providerInputs[0].hash, shot.startImage.hash);
  assert.equal(await videoJobIsCurrent(started.project, started.job), true);
  await assert.rejects(videoManifest(p, shot, connection), /寸法/);
  await assert.rejects(beginVideoJob(started.project, shot.id, localConnection), /未確定/);
  assert.deepEqual(started.project.panels, p.panels);
});

test('MV-01 v1/v2/v3 file roundtrip preserves manga and video; restart never resubmits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manga-video-'));
  try {
    for (const version of [1, 2, 3]) {
      const p = await migrateProject({ ...legacy, version });
      assert.equal(p.version, 4);
      assert.deepEqual(p.snapshots, legacy.snapshots);
      assert.deepEqual(p.characters, legacy.characters);
      assert.deepEqual(p.jobs, legacy.jobs);
      assert.equal(p.history[0].panels[0].image, legacy.history[0].panels[0].image);
      assert.deepEqual(await migrateProject(p), p);
    }
    const p = await fixture(), before = structuredClone(p), started = await beginVideoJob(p, p.videoShots[0].id, connection);
    assert.deepEqual(p, before);
    const path = join(dir, 'project.json');
    await writeFile(path, JSON.stringify(started.project));
    const restored = await migrateProject(JSON.parse(await readFile(path)), true);
    assert.deepEqual(restored.panels, p.panels);
    assert.deepEqual(restored.history, p.history);
    assert.deepEqual(restored.videoShots, p.videoShots);
    assert.deepEqual(restored.jobs.at(-1).manifest, started.job.manifest);
    assert.equal(restored.jobs.at(-1).status, 'unknown');
    await assert.rejects(beginVideoJob(restored, p.videoShots[0].id, connection));
    assert.deepEqual(await migrateProject(restored), restored);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MV-02/03 existing artwork bytes and capture bytes share one resolver, provenance is not provider input', async () => {
  const p = await fixture(), shot = p.videoShots[0];
  const result = await videoManifest(p, shot, connection);
  assert.equal(result.image, p.panels[0].image);
  assert.equal(result.manifest.providerInputs.length, 1);
  assert.equal(result.manifest.providerInputs[0].hash, await imageHash(result.image));
  assert.equal(result.manifest.providerInputs[0].role, 'start_frame');
  assert.equal(result.manifest.sourceDependencies.artwork_revision, shot.startImage.id);
  assert.ok(!JSON.stringify(result.manifest).includes('base64'));
  const image = { hash: shot.startImage.hash }, checkpoint = { hash: 'a'.repeat(64) };
  const capture = { id: 'capture:test', session_id: 's', request_id: 'r', image, checkpoint, dependencies_pinned: true, character_bindings: [{ character_id: 'a' }] };
  p.captures = [capture];
  const ref = { kind: 'capture', id: capture.id, hash: image.hash };
  const load = async (session, request) => { assert.equal(session, 's'); assert.equal(request, 'r'); return { session_id: session, request_id: request, preview: result.image, state: { image, checkpoint, dependencies_pinned: true } }; };
  const resolved = await resolveStartImage(p, ref, load);
  assert.equal(resolved.image, result.image);
  assert.equal(resolved.sourceDependencies.checkpoint_hash, checkpoint.hash);
  await assert.rejects(resolveStartImage(p, ref, async () => ({ ...(await load('s', 'r')), request_id: 'wrong' })));
  p.artworks.find(a => a.id === shot.startImage.id).panel.image = legacy.history[0].panels[0].image;
  await assert.rejects(videoManifest(p, shot, connection));
});

test('MV-04 unsupported controls, reordered/foreign units, missing assets and invalid model fail before transport', async () => {
  const p = await fixture(), shot = p.videoShots[0];
  for (const patch of [{ duration: 11 }, { ratio: '1920:1080' }, { endImage: shot.startImage }, { depth: 'x' },
    { unitIds: [...shot.unitIds].reverse() }, { unitIds: ['other:u0'] }, { characterIds: ['unknown'] },
    { prompt: 'x'.repeat(1001) }, { startImage: { ...shot.startImage, id: 'missing' } }]) {
    await assert.rejects(videoManifest(p, { ...shot, ...patch }, connection));
  }
  await assert.rejects(videoManifest(p, shot, { ...connection, model: 'invented' }));
  await assert.rejects(videoManifest(p, shot, { ...connection, api_key: 'must-not-persist' }));
});

test('Runway provider accepts another registered model without changing video job contracts', async () => {
  const p = await fixture(), shot = p.videoShots[0];
  const turbo = { id: 'turbo', provider: 'runway', model: 'gen4_turbo', adapter_id: 'runway' };
  const result = await videoManifest(p, { ...shot, duration: 6 }, turbo);
  assert.equal(result.manifest.connection.provider, 'runway');
  assert.equal(result.manifest.connection.model, 'gen4_turbo');
  assert.equal(result.manifest.duration, 6);
  assert.equal(result.manifest.providerInputs[0].role, 'start_frame');
  await assert.rejects(videoManifest(p, { ...shot, duration: 11 }, turbo), /尺・寸法/);
});

test('Seedance jobs pin request profile, silent audio and pricing before paid submission', async () => {
  const p = await fixture(), shot = p.videoShots[0];
  const seedance = { id: 'seedance-binding', provider: 'runway', model: 'seedance2_5', adapter_id: 'runway' };
  const request = await videoManifest(p, shot, seedance);
  assert.equal(request.manifest.version, 2);
  assert.equal(request.manifest.request_profile, 'seedance-keyframes-v1');
  assert.equal(request.manifest.audio, false);
  assert.deepEqual(request.manifest.billing, {
    credits: 150, rate: 30, minimum: 80, tier: '720p', checked_at: '2026-09-22',
    model_id: 'seedance2_5', request_profile: 'seedance-keyframes-v1'
  });
  assert.equal(request.manifest.providerInputs.length, 1);
  const long = { ...shot, prompt: 'x'.repeat(15000) };
  await assert.doesNotReject(videoManifest(p, long, seedance));
  await assert.rejects(videoManifest(p, { ...shot, prompt: 'x'.repeat(15001) }, seedance), /指示/);
});

test('MV-05 input/source/adopted version changes invalidate result; attempts survive abandonment', async () => {
  const p = await fixture(), shot = p.videoShots[0], { project, job } = await beginVideoJob(p, shot.id, connection);
  assert.equal(await videoJobIsCurrent(project, job), true);
  for (const change of [{ prompt: 'changed' }, { adopted_revision: 'new-video' }, { ratio: '1280:720' }]) {
    assert.equal(await videoJobIsCurrent({ ...project, videoShots: [{ ...shot, ...change }] }, job), false);
  }
  assert.equal(await videoJobIsCurrent({ ...project, active: 'new' }, job), false);
  let attempts = project;
  for (let i = 1; i < 3; i++) {
    attempts = { ...attempts, jobs: attempts.jobs.map(j => j.kind === 'video' ? { ...j, status: 'abandoned' } : j) };
    attempts = (await beginVideoJob(attempts, shot.id, connection)).project;
  }
  attempts.jobs.at(-1).status = 'abandoned';
  await assert.rejects(beginVideoJob(attempts, shot.id, connection));
  assert.deepEqual(attempts.panels, p.panels);
  assert.deepEqual(attempts.history, p.history);
});

test('MV-07/08 candidates, native verification and per-shot Undo preserve manga across reload', async () => {
  const p = await fixture(), shotId = p.videoShots[0].id;
  const { project, job } = await beginVideoJob(p, shotId, connection);
  const artifact = { artifact_id: 'a'.repeat(64), hash: 'a'.repeat(64), mime: 'video/mp4', size: 1838 };
  const collected = collectVideoResult(project, job.id, artifact);
  assert.equal(collected.videoShots[0].adopted_revision, null);
  assert.equal(collected.jobs.at(-1).status, 'candidate');
  assert.throws(() => collectVideoResult(collected, job.id, artifact));
  await assert.rejects(adoptVideoCandidate(collected, job.id));
  await assert.rejects(adoptVideoCandidate(collected, job.id, async () => { throw Error('corrupt file'); }));
  const verify = async a => assert.deepEqual(a, artifact);
  const adopted = await adoptVideoCandidate(collected, job.id, verify);
  const next = await beginVideoJob(adopted, shotId, connection);
  const second = await adoptVideoCandidate(collectVideoResult(next.project, next.job.id, artifact), next.job.id, verify);
  const reloaded = await migrateProject(JSON.parse(JSON.stringify(second)), true);
  const undone = await undoVideo(reloaded, shotId, verify);
  assert.equal(undone.videoShots[0].adopted_revision, adopted.videoShots[0].adopted_revision);
  assert.deepEqual(undone.panels, p.panels);
  assert.deepEqual(undone.history, p.history);
  assert.equal(undone.videoRevisions.length, 2);
  const empty = await undoVideo(undone, shotId, verify);
  assert.equal(empty.videoShots[0].adopted_revision, null);
  await assert.rejects(undoVideo(empty, shotId, verify));
  await assert.rejects(adoptVideoCandidate({ ...collected, active: 'changed' }, job.id, verify));
  assert.throws(() => collectVideoResult(project, job.id, { ...artifact, hash: '../escape' }));
});

test('encoded image limit and mismatched aspect are rejected before submission without implicit crop', async () => {
  const p = await fixture(), shot = p.videoShots[0];
  assert.deepEqual(validateVideoFrame(p.panels[0].image, '960:960'), { width: 1, height: 1 });
  assert.throws(() => validateVideoFrame(p.panels[0].image, '1280:720'));
  assert.throws(() => validateVideoFrame('data:image/jpeg;base64,AAAA', '960:960'));
  const image = `data:image/png;base64,${Buffer.alloc(3_800_000).toString('base64')}`;
  const hash = await imageHash(image), id = 'large';
  const large = { ...p, artworks: [...p.artworks, { id, hash, panel: { image } }] };
  await assert.rejects(resolveStartImage(large, { kind: 'artwork', id, hash }), /base64/);
  await assert.rejects(videoManifest(p, { ...shot, ratio: '1280:720' }, connection), /縦横比/);
});
