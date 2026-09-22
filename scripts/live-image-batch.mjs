import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyProject } from '../src/core.js';
import { producePanels } from '../src/production.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = process.env.MANGA_ENGINE ?? path.join(root, 'helper/.build/release/manga-engine');
const artifactRoot = path.resolve(process.env.IMAGE_BATCH_ARTIFACTS ?? path.join(root, 'live-image-batch-results'));
const modelId = 'flux-2-klein-4b-q6-local';
const modelFile = 'flux_2_klein_4b_q6p.ckpt';
const prompts = [
  'A quiet school library in the morning, sunlight through tall windows, cinematic black and white manga panel, no people',
  'An empty high school corridor after rain, reflections on the floor, cinematic black and white manga panel, no people',
  'A small train station platform at dusk, gentle wind moving nearby leaves, cinematic black and white manga panel, no people',
];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function pngSize(bytes) {
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', 'output is not a PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
function projectFixture() {
  const snapshot = { id: 'live-image-batch-snapshot', repo: 'kdob1042/manga-mac', scenes: prompts.map((text, index) => ({ id: `scene-${index + 1}`, text })), settings: [] };
  const panels = prompts.map((prompt, index) => ({ id: `panel-${index + 1}`, sceneId: `scene-${index + 1}`, snapshotId: snapshot.id, unitIds: [], sourceRefs: [], characterIds: [], prompt, image: null, instructions: [], attempts: 0, status: 'planned' }));
  return { ...emptyProject(), workId: 'live-image-batch', active: snapshot.id, snapshots: [snapshot], panels, mediaDefaults: { image: modelId, video: 'runway-gen4-5' } };
}

await mkdir(artifactRoot, { recursive: true });
let project = projectFixture();
const timeline = [];
let active = 0;
let maxActive = 0;
async function commit(next) {
  project = typeof next === 'function' ? next(project) : next;
  await writeFile(path.join(artifactRoot, 'project.json'), JSON.stringify(project, null, 2));
  return project;
}
async function generate(panel, _characters, _original, _instruction, job) {
  active += 1;
  maxActive = Math.max(maxActive, active);
  const startedAt = Date.now();
  const index = Number(panel.id.split('-').at(-1));
  const output = path.join(artifactRoot, panel.id);
  await mkdir(output, { recursive: true });
  const requestHash = sha256(Buffer.from(JSON.stringify({ panelId: panel.id, jobId: job.id, prompt: panel.prompt })));
  const request = { output: { directory: output, request_hash: requestHash }, prompt: `${panel.prompt}\nBlack and white manga illustration. No text, no lettering, no balloons.`, references: [], original: null, seed: 2400 + index, width: 256, height: 256, steps: 4, media: { adapter_id: 'media-generation-kit', model_id: modelFile }, output_kind: 'image' };
  await writeFile(path.join(output, 'request.json'), JSON.stringify(request, null, 2));
  const result = spawnSync('/usr/bin/time', ['-l', '/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', engine], {
    input: JSON.stringify(request), encoding: 'utf8', env: Object.fromEntries(['HOME', 'TMPDIR', 'PATH', 'LANG'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])), maxBuffer: 16 * 1024 * 1024,
  });
  const finishedAt = Date.now();
  active -= 1;
  await writeFile(path.join(output, 'engine.stdout.log'), result.stdout ?? '');
  await writeFile(path.join(output, 'engine.stderr.log'), result.stderr ?? '');
  assert.equal(result.status, 0, `helper failed for ${panel.id}: ${result.stderr}`);
  assert.match(result.stdout, /MANGA_RESULT_SAVED/);
  const image = await readFile(path.join(output, 'result.png'));
  assert.deepEqual(pngSize(image), [256, 256]);
  const receipt = JSON.parse(await readFile(path.join(output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.request_hash, requestHash);
  assert.equal(receipt.hash, sha256(image));
  const rss = /([0-9]+)\s+maximum resident set size/.exec(result.stderr)?.[1];
  timeline.push({ panelId: panel.id, jobId: job.id, startedAt, finishedAt, durationMs: finishedAt - startedAt, peakRssBytes: rss ? Number(rss) : null, hash: receipt.hash });
  return { ...panel, image: `data:image/png;base64,${image.toString('base64')}`, status: 'review', attempts: panel.attempts + 1 };
}

await producePanels({ current: () => project, commit, panelIds: project.panels.map(panel => panel.id), imageModelId: modelId, generate });
assert.equal(maxActive, 1, 'batch inference was not sequential');
assert.equal(timeline.length, 3);
assert.ok(timeline.every((item, index) => index === 0 || item.startedAt >= timeline[index - 1].finishedAt));
assert.deepEqual(project.jobs.map(job => job.status), ['complete', 'complete', 'complete']);
assert.ok(project.jobs.every(job => job.media.registry_id === modelId && job.media.model_id === modelFile));
assert.ok(project.panels.every(panel => panel.image?.startsWith('data:image/png;base64,')));
const summary = { passed: true, model: { registryId: modelId, modelFile, width: 256, height: 256, steps: 4 }, batch: { requested: 3, completed: project.jobs.filter(job => job.status === 'complete').length, maxConcurrency: maxActive }, timeline, environment: { arch: process.arch, platform: process.platform, runner: process.env.RUNNER_NAME ?? null, image: process.env.ImageOS ?? null } };
await writeFile(path.join(artifactRoot, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
