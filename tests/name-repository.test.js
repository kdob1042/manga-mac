import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepositoryNamePlan, repositoryNamePlanPath, validateRepositoryNameTarget } from '../src/name-repository.js';
import { MAX_BYTES } from '../contracts/name-plan/schema.mjs';
import { atomize, sourceDescriptor } from '../contracts/name-plan/source.mjs';
import { createNameCandidate, adoptNameCandidate } from '../src/name-v2.js';
import { fileFixture } from './name-plan-fixture.mjs';

async function fixture() {
  const f = await fileFixture(2, '# Scene\n\n手を振る😀。\n\n「また明日」');
  f.snapshot.episodeId = 'P01'; f.snapshot.episodeIds = ['P01'];
  f.snapshot.library = { root: 'works/example' };
  delete f.file.source.commit;
  return f;
}
const targetFor = snapshot => ({ repo: snapshot.repo, commit: snapshot.sha, episodeId: 'P01', path: repositoryNamePlanPath(snapshot, 'P01') });

test('repository path uses the work root and imported episode, not source/manifest directory', async () => {
  const { snapshot } = await fixture();
  snapshot.sync.manifest_path = 'works/example/source/manifest.json';
  assert.equal(repositoryNamePlanPath(snapshot, 'P01'), 'works/example/manga/P01/name-plan.json');
  assert.throws(() => repositoryNamePlanPath(snapshot, 'P02'), /取り込んだ原稿/);
  delete snapshot.library;
  snapshot.sync.source_root = 'works/other';
  assert.equal(repositoryNamePlanPath(snapshot, 'P01'), 'works/other/manga/P01/name-plan.json');
});

for (const change of [
  s => { s.sha = 'main'; }, s => { s.repo = 'https://elsewhere.invalid'; },
  s => { s.library.root = '../outside'; }, s => { s.library.root = '/outside'; },
  s => { s.library.root = 'works/example\n'; }, s => { s.library.root = 'works/%2e%2e/other'; },
]) test(`unsafe retrieval target fails before transport: ${change}`, async () => {
  const { snapshot } = await fixture(); change(snapshot); let calls = 0;
  await assert.rejects(fetchRepositoryNamePlan(snapshot, 'P01', '', async () => { calls++; }));
  assert.equal(calls, 0);
});

test('all retrieval parameters and returned provenance are frozen before transport', async () => {
  const { snapshot } = await fixture(), expected = targetFor(snapshot), calls = [];
  const fetched = await fetchRepositoryNamePlan(snapshot, 'P01', 'memory-only-token', async (command, args) => {
    calls.push([command, args]); snapshot.sha = 'b'.repeat(40); snapshot.library.root = 'works/later';
    return '{}';
  });
  assert.deepEqual(calls, [['github_file', { repo: expected.repo, path: expected.path, sha: expected.commit, token: 'memory-only-token' }]]);
  assert.deepEqual(fetched, { raw: '{}', ...expected });
  assert.equal(JSON.stringify(fetched).includes('memory-only-token'), false);
});

for (const raw of [null, {}, ' '.repeat(MAX_BYTES + 1)]) test(`invalid transport payload is rejected: ${typeof raw}`, async () => {
  const { snapshot } = await fixture(); let calls = 0;
  await assert.rejects(fetchRepositoryNamePlan(snapshot, 'P01', '', async () => { calls++; return raw; }));
  assert.equal(calls, 1);
});

test('missing file or authentication failure is not retried against another path/HEAD', async () => {
  const { snapshot } = await fixture(); let calls = 0;
  await assert.rejects(fetchRepositoryNamePlan(snapshot, 'P01', '', async () => { calls++; throw Error('not available'); }), /not available/);
  assert.equal(calls, 1);
});

test('repository retrieval uses the real v2 validation, compilation, candidate and adoption path without generation', async () => {
  const { project, snapshot, file } = await fixture(), before = structuredClone(project), calls = [];
  const fetched = await fetchRepositoryNamePlan(snapshot, 'P01', '', async (command, args) => {
    calls.push({ command, sha: args.sha }); return JSON.stringify(file);
  });
  validateRepositoryNameTarget(project, JSON.parse(fetched.raw), fetched);
  const repository = await createNameCandidate(project, fetched.raw);
  const manualFile = await createNameCandidate(project, JSON.stringify(file));
  assert.equal(repository.fileHash, manualFile.fileHash);
  assert.deepEqual(repository.layout, manualFile.layout);
  assert.deepEqual(project, before);
  const staged = { ...project, jobs: [{ id: 'repository-candidate', kind: 'name_plan', status: 'candidate', nameCandidate: repository, repositoryPlan: targetFor(snapshot) }] };
  assert.deepEqual(staged.panels, []);
  const adopted = await adoptNameCandidate(staged, repository);
  const restored = JSON.parse(JSON.stringify(adopted));
  assert.equal(restored.namePlan.status, 'adopted');
  assert.equal(restored.panels.length, 2);
  assert.deepEqual(restored.panels[0].requiredText, []);
  assert.equal(restored.panels[1].requiredText.length, 1);
  assert.deepEqual(restored.sourceApplication.units, []);
  assert.deepEqual(restored.jobs[0].repositoryPlan, targetFor(snapshot));
  assert.deepEqual(calls, [{ command: 'github_file', sha: snapshot.sha }]);
  assert.equal(restored.jobs.some(j => ['generate', 'retake', 'video'].includes(j.kind)), false);
});

for (const key of ['commit', 'repo', 'path']) test(`stale or forged retrieval identity is rejected: ${key}`, async () => {
  const { project, snapshot, file } = await fixture(), target = targetFor(snapshot);
  target[key] = 'wrong';
  assert.throws(() => validateRepositoryNameTarget(project, file, target));
});

test('a plan for a different primary episode cannot hide behind the selected file path', async () => {
  const f = await fixture();
  f.snapshot.episodeIds.push('P02');
  f.snapshot.scenes.push({ id: 'S02', episodeId: 'P02', text: '# Another\n\n違う話。' });
  f.file.source.selectedAtomIds = atomize(f.snapshot, ['S02']).map(a => a.id);
  assert.throws(() => validateRepositoryNameTarget(f.project, f.file, targetFor(f.snapshot)), /取得した話/);
});

test('read-only context from the next episode is allowed without adapting it', async () => {
  const f = await fixture();
  f.snapshot.episodeIds.push('P02');
  f.snapshot.scenes.push({ id: 'S02', episodeId: 'P02', text: '# Another\n\n次の場面。' });
  const contextId = atomize(f.snapshot, ['S02'])[0].id;
  f.file.plan.panels[0].contextAtomIds = [contextId];
  f.file.source = await sourceDescriptor(f.project, f.snapshot, f.atoms, [contextId]);
  validateRepositoryNameTarget(f.project, f.file, targetFor(f.snapshot));
  const candidate = await createNameCandidate(f.project, f.file);
  assert.equal(candidate.panels[0].contextRefs[0].sceneId, 'S02');
  assert.equal(candidate.panels.flatMap(p => p.sourceRefs).some(r => r.sceneId === 'S02'), false);
});

for (const mutate of [
  f => { f.file.source.workId = 'other'; },
  f => { f.file.source.selectedAtomIds = ['missing']; },
  f => { f.file.source.selectedAtomIds = []; },
]) test(`invalid repository plan scope never reaches adoption: ${mutate}`, async () => {
  const f = await fixture(); mutate(f); const before = structuredClone(f.project);
  assert.throws(() => validateRepositoryNameTarget(f.project, f.file, targetFor(f.snapshot)));
  assert.deepEqual(f.project, before);
});

for (const mutate of [
  f => { f.snapshot.scenes[0].text += '変更'; },
  f => { f.snapshot.settings = [{ id: 's', text: '設定変更' }]; },
  f => { f.snapshot.characters = [{ id: 'new', name: '変更' }]; },
]) test(`shared source validator remains authoritative after repository retrieval: ${mutate}`, async () => {
  const f = await fixture(); mutate(f); const before = structuredClone(f.project);
  await assert.rejects(createNameCandidate(f.project, f.file));
  assert.deepEqual(f.project, before);
});
