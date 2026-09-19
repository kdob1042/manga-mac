import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrateProject, imageHash } from '../src/revisions.js';
import { template } from '../src/layout.js';
import { videoManifest, beginVideoJob, videoJobIsCurrent } from '../src/video.js';
import { adjacentPanelPairs, createAdjacentVideoShot, createSelectedAdjacentVideoShots } from '../src/video-transition.js';

const legacy = JSON.parse(await readFile(new URL('./fixtures/legacy-v1.json', import.meta.url)));
const runway = { id: 'runway', provider: 'runway', model: 'gen4.5' };
const fixtureConnection = { id: 'fixture', provider: 'fixture', model: 'end-frame-v1' };

async function pairFixture() {
  const project = await migrateProject(legacy);
  const from = project.panels[0];
  const sourceArtwork = project.artworks.find(artwork => artwork.id === from.artwork_revision);
  // Two distinct square artwork bytes, plus the legacy character reference image.
  // Keeping dimensions equal exercises the real A/B byte ordering without a crop.
  const alternateImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const to = { ...structuredClone(from), id: 's:p1', image: alternateImage, artwork_revision: 'fixture:artwork:p1' };
  const toArtwork = { ...structuredClone(sourceArtwork), id: to.artwork_revision, hash: await imageHash(alternateImage), panel: structuredClone(to) };
  return {
    ...project,
    panels: [from, to],
    artworks: [...project.artworks, toArtwork],
    layout: { version: 1, pages: [{ id: 'page:0', slots: template(2, [from.id, to.id]) }], knownPanelIds: [from.id, to.id] },
  };
}

test('selective adjacent execution keeps zero selection as a no-op and creates only checked pairs', async () => {
  const project = await pairFixture();
  assert.strictEqual(createSelectedAdjacentVideoShots(project, [], { prompt: '', duration: 5, ratio: '960:960' }), project);
  assert.strictEqual(createSelectedAdjacentVideoShots(project, undefined, { prompt: '', duration: 5, ratio: '960:960' }), project);
  const pairs = adjacentPanelPairs(project);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].valid, true);
  const next = createSelectedAdjacentVideoShots(project, [pairs[0].id], { prompt: 'AからBへゆっくり移る', duration: 5, ratio: '960:960' });
  assert.equal(next.videoShots.length, 1);
  assert.equal(next.videoShots[0].transition.fromPanelId, 's:p0');
  assert.equal(next.videoShots[0].transition.toPanelId, 's:p1');
});

test('A→B manifest preserves adopted artwork identities, dimensions and ordered inputs', async () => {
  const project = await pairFixture();
  const pair = adjacentPanelPairs(project)[0];
  const withShot = createAdjacentVideoShot(project, { pairId: pair.id, prompt: 'AからBへ移る', duration: 5, ratio: '960:960' });
  const shot = withShot.videoShots[0];
  await assert.rejects(videoManifest(withShot, shot, runway), /終端画像/);
  const request = await videoManifest(withShot, shot, fixtureConnection);
  assert.deepEqual(request.manifest.providerInputs.map(input => input.role), ['start_frame', 'end_frame']);
  assert.equal(request.manifest.providerInputs[0].id, shot.transition.fromArtworkRevisionId);
  assert.equal(request.manifest.providerInputs[1].id, shot.transition.toArtworkRevisionId);
  assert.equal(request.manifest.providerInputs[0].hash, shot.transition.fromArtworkHash);
  assert.equal(request.manifest.providerInputs[1].hash, shot.transition.toArtworkHash);
  assert.notEqual(request.manifest.providerInputs[0].hash, request.manifest.providerInputs[1].hash);
  assert.equal(request.manifest.source.from.panelId, shot.transition.fromPanelId);
  assert.equal(request.manifest.source.to.panelId, shot.transition.toPanelId);
  const started = await beginVideoJob(withShot, shot.id, fixtureConnection);
  assert.equal(await videoJobIsCurrent(started.project, started.job), true);
});

test('changing B artwork or page reading order invalidates the pair before generation', async () => {
  const project = await pairFixture();
  const pair = adjacentPanelPairs(project)[0];
  const withShot = createAdjacentVideoShot(project, { pairId: pair.id, prompt: 'AからBへ移る', duration: 5, ratio: '960:960' });
  const changedArtwork = { ...withShot.artworks.find(artwork => artwork.id === withShot.videoShots[0].transition.toArtworkRevisionId), hash: 'b'.repeat(64) };
  await assert.rejects(videoManifest({ ...withShot, artworks: withShot.artworks.map(artwork => artwork.id === changedArtwork.id ? changedArtwork : artwork) }, withShot.videoShots[0], fixtureConnection), /採用作画版/);
  const page = withShot.layout.pages[0];
  const reordered = { ...withShot, layout: { ...withShot.layout, pages: [{ ...page, slots: [...page.slots].reverse() }] } };
  await assert.rejects(videoManifest(reordered, withShot.videoShots[0], fixtureConnection), /読書順/);
});

test('duplicate pair selections are rejected before saving', async () => {
  const project = await pairFixture();
  const pair = adjacentPanelPairs(project)[0];
  assert.throws(
    () => createSelectedAdjacentVideoShots(project, [pair.id, pair.id], { prompt: '重複', duration: 5, ratio: '960:960' }),
    /重複/
  );
});
