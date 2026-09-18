import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT,
  parseScenePath,
  resolveSourcePath,
  scenePathFor,
} from '../paths.mjs';
import {
  StorySourceValidationError,
  manifestToSourceModel,
  validateManifest,
  validateSourceTree,
} from '../validate.mjs';
import {
  planAddEpisode,
  planAddScene,
  planMoveEpisode,
  planMoveScene,
  planRemoveEpisode,
  planRemoveScene,
  planStructureChange,
} from '../structure.mjs';

function manifest() {
  return {
    format: FORMAT,
    work: { title: '神谷と河合' },
    episodes: [
      {
        id: 'ep_a',
        title: '放課後',
        scenes: [
          { id: 'sc_a', path: 'manuscript/p01/p01-01.md', tags: ['会話', ' 雨 '] },
          { id: 'sc_b', path: 'manuscript/p01/p01-02.md' },
        ],
      },
      {
        id: 'ep_b',
        title: '駅',
        scenes: [
          { id: 'sc_c', path: 'manuscript/p02/p02-01.md', tags: ['駅'] },
        ],
      },
    ],
    settings: [{ id: 'WORLD', path: 'settings/world.md' }],
    characters: [{ id: 'ch_yu', name: '勇', image: 'assets/yu.jpg', description: '短髪' }],
  };
}

function codes(error) {
  assert(error instanceof StorySourceValidationError);
  return error.issues.map(item => item.code);
}

test('validates the canonical nested manifest and creates a display-order model', () => {
  const raw = manifest();
  const normalized = validateManifest(raw);
  assert.deepEqual(normalized, raw);
  const model = manifestToSourceModel(raw);
  assert.deepEqual(model.scenes.map(scene => [scene.id, scene.displayNumber, scene.episodeId]), [
    ['sc_a', 'P1-1', 'ep_a'],
    ['sc_b', 'P1-2', 'ep_a'],
    ['sc_c', 'P2-1', 'ep_b'],
  ]);
  assert.deepEqual(raw.episodes[0].scenes[0].tags, ['会話', ' 雨 ']);
  const withoutReferenceImage = structuredClone(raw);
  delete withoutReferenceImage.characters[0].image;
  assert.deepEqual(validateManifest(withoutReferenceImage).characters, [{ id: 'ch_yu', name: '勇', description: '短髪' }]);
});

test('uses explicit paths and rejects old schemas, mismatches, duplicates and unsafe references', () => {
  for (const change of [
    { format: 'schema-4' },
    { episodes: [{ ...manifest().episodes[0], scenes: [{ id: 'sc_a', path: 'manuscript/p01/p01-02.md' }, manifest().episodes[0].scenes[1]] }, manifest().episodes[1]] },
    { settings: [{ id: 'WORLD', path: '../world.md' }] },
    { characters: [{ id: 'ch_yu', name: '勇', image: 'assets/a.png' }, { id: 'ch_yu', name: '別人', image: 'assets/b.png' }] },
    { episodes: [{ ...manifest().episodes[0], scenes: [{ id: 'sc_a', path: 'manuscript/p01/p01-01.md' }, { id: 'sc_a', path: 'manuscript/p01/p01-02.md' }] }, manifest().episodes[1]] },
  ]) {
    assert.throws(() => validateManifest({ ...manifest(), ...change }), error => codes(error).length > 0);
  }
  assert.throws(() => validateManifest(manifest(), { retiredIds: ['sc_b'] }), error => codes(error).includes('RETIRED_ID_REUSED'));
});

test('checks declared files, unregistered files and leading Markdown headings without changing content', () => {
  const raw = manifest();
  const files = new Map([
    ['manuscript/p01/p01-01.md', '# 待ち合わせ\n\n本文  そのまま'],
    ['manuscript/p01/p01-02.md', '# 図書館\n\n台詞'],
    ['manuscript/p02/p02-01.md', '# 駅\n\n雨'],
    ['settings/world.md', '# 世界設定\n\n画像 ![地図](../assets/map.png)'],
    ['assets/yu.jpg', new Uint8Array([1, 2, 3])],
  ]);
  const result = validateSourceTree(raw, files);
  assert.equal(result.files.get('manuscript/p01/p01-01.md'), '# 待ち合わせ\n\n本文  そのまま');

  const bad = new Map(files);
  bad.set('manuscript/p02/p02-01.md', '本文だけ');
  bad.set('assets/unregistered.png', new Uint8Array([1]));
  bad.delete('settings/world.md');
  assert.throws(() => validateSourceTree(raw, bad), error => {
    const found = codes(error);
    return found.includes('MISSING_HEADING') && found.includes('UNREGISTERED_FILE') && found.includes('MISSING_FILE');
  });
});

test('canonical paths widen together when an index reaches three digits', () => {
  assert.equal(scenePathFor(1, 1, { episodeCount: 1, sceneCount: 100 }), 'manuscript/p01/p01-001.md');
  assert.equal(scenePathFor(100, 1, { episodeCount: 100, sceneCount: 1 }), 'manuscript/p100/p100-01.md');
  assert.deepEqual(parseScenePath('manuscript/p01/p01-001.md'), { episodeNumber: 1, sceneNumber: 1 });
  assert.equal(parseScenePath('manuscript/p1/p1-1.md'), null);
  assert.ok(resolveSourcePath('/tmp/story-source', 'manuscript/p01/p01-01.md').endsWith('/story-source/manuscript/p01/p01-01.md'));
  assert.throws(() => resolveSourcePath('/tmp/story-source', '../outside.md'), /安全な相対パス/);
});

test('adding a scene preserves fixed IDs and returns a collision-safe file plan', () => {
  const before = manifest();
  const plan = planAddScene(before, { episodeId: 'ep_a', afterSceneId: 'sc_a', sceneId: 'sc_new', tags: ['追加'] });
  assert.deepEqual(before.episodes[0].scenes.map(scene => scene.id), ['sc_a', 'sc_b']);
  assert.deepEqual(plan.after.episodes[0].scenes.map(scene => [scene.id, scene.path]), [
    ['sc_a', 'manuscript/p01/p01-01.md'],
    ['sc_new', 'manuscript/p01/p01-02.md'],
    ['sc_b', 'manuscript/p01/p01-03.md'],
  ]);
  assert.deepEqual(plan.filePlan.creates, [{ id: 'sc_new', to: 'manuscript/p01/p01-02.md', reason: 'add-scene' }]);
  assert.deepEqual(plan.filePlan.renames, [{ id: 'sc_b', from: 'manuscript/p01/p01-02.md', to: 'manuscript/p01/p01-03.md', reason: 'add-scene' }]);
  assert.equal(plan.filePlan.stageMoves[0].staging, '__story_source_staging__/0001.md');
});

test('moving a scene across episodes changes only its ownership/order and keeps its ID', () => {
  const plan = planMoveScene(manifest(), { sceneId: 'sc_b', targetEpisodeId: 'ep_b', afterSceneId: 'sc_c' });
  assert.deepEqual(plan.after.episodes.map(episode => episode.scenes.map(scene => scene.id)), [['sc_a'], ['sc_c', 'sc_b']]);
  assert.equal(plan.after.episodes[1].scenes[1].path, 'manuscript/p02/p02-02.md');
  assert.equal(plan.filePlan.renames.find(entry => entry.id === 'sc_b').from, 'manuscript/p01/p01-02.md');
});

test('removal records retired IDs and prevents accidental reuse', () => {
  const plan = planRemoveScene(manifest(), { sceneId: 'sc_b' });
  assert.ok(plan.filePlan.retiredIds.includes('sc_b'));
  assert.deepEqual(plan.filePlan.removes, [{ id: 'sc_b', from: 'manuscript/p01/p01-02.md', reason: 'remove-scene' }]);
  assert.throws(() => planAddScene(plan.after, { episodeId: 'ep_a', sceneId: 'sc_b', retiredIds: plan.filePlan.retiredIds }), /新しいIDを発行できません/);
});

test('episode operations are pure and generic dispatch uses the same validator', () => {
  const added = planAddEpisode(manifest(), {
    episodeId: 'ep_c',
    title: '第三話',
    afterEpisodeId: 'ep_a',
    initialScenes: [{ id: 'sc_d', tags: ['新話'] }],
  });
  assert.deepEqual(added.after.episodes.map(episode => episode.id), ['ep_a', 'ep_c', 'ep_b']);
  assert.equal(added.after.episodes[2].scenes[0].path, 'manuscript/p03/p03-01.md');
  const moved = planMoveEpisode(added.after, { episodeId: 'ep_c', afterEpisodeId: null });
  assert.deepEqual(moved.after.episodes.map(episode => episode.id), ['ep_c', 'ep_a', 'ep_b']);
  const removed = planRemoveEpisode(moved.after, { episodeId: 'ep_c' });
  assert.ok(removed.filePlan.retiredIds.includes('ep_c'));
  assert.ok(removed.filePlan.retiredIds.includes('sc_d'));
  const reindexed = planStructureChange(manifest(), 'reindex');
  assert.equal(reindexed.changed, false);
});

test('the JSON schema declares the same single format', async () => {
  const schema = JSON.parse(await readFile(new URL('../manifest.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.format.const, FORMAT);
  assert.deepEqual(schema.required, ['format', 'work', 'episodes', 'settings', 'characters']);
  assert.equal(schema.additionalProperties, false);
});
