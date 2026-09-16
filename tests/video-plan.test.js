import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateProject } from '../src/revisions.js';
import { createVideoShot } from '../src/video.js';
import { motionFromPlan } from '../src/video-plan.js';

test('video motion planning reuses exact source range and characters, rejecting invented scope', async () => {
  let p = await migrateProject(JSON.parse(readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url))));
  const panel = p.panels[0], artwork = p.artworks.find(a => a.id === panel.artwork_revision);
  p = createVideoShot(p, { snapshotId: panel.snapshotId, sceneId: panel.sceneId, unitIds: panel.unitIds, characterIds: panel.characterIds,
    startImage: { kind: 'artwork', id: artwork.id, hash: artwork.hash }, prompt: 'Initial', duration: 5, ratio: '1280:720' });
  const shot = p.videoShots[0], good = { panels: [{ unitIds: shot.unitIds, characterIds: shot.characterIds, prompt: 'カメラがゆっくり寄る' }] };
  const before = structuredClone(p);
  assert.equal(motionFromPlan(p, shot, good), 'カメラがゆっくり寄る');
  assert.deepEqual(p, before);
  for (const patch of [{ unitIds: [] }, { unitIds: [...shot.unitIds].reverse() }, { characterIds: ['invented'] }, { characterIds: [] }, { prompt: 'x'.repeat(1001) }]) {
    assert.throws(() => motionFromPlan(p, shot, { panels: [{ ...good.panels[0], ...patch }] }));
  }
  assert.throws(() => motionFromPlan(p, shot, { panels: [...good.panels, ...good.panels] }));
});
