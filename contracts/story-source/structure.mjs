import { FORMAT, scenePathFor } from './paths.mjs';
import { validateManifest } from './validate.mjs';

function clone(value) {
  return structuredClone(value);
}

function allIds(manifest) {
  const ids = new Set();
  for (const episode of manifest.episodes) {
    ids.add(episode.id);
    for (const scene of episode.scenes) ids.add(scene.id);
  }
  for (const setting of manifest.settings) ids.add(setting.id);
  for (const character of manifest.characters) ids.add(character.id);
  return ids;
}

function sceneEntries(manifest) {
  const entries = new Map();
  for (const episode of manifest.episodes) {
    for (const scene of episode.scenes) entries.set(scene.id, { ...scene, episodeId: episode.id });
  }
  return entries;
}

function newId(prefix, manifest, requested, idFactory, retiredIds) {
  const used = allIds(manifest);
  const retired = new Set(retiredIds);
  let id = requested;
  if (id === undefined || id === null) {
    const factory = idFactory ?? ((kind) => {
      const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      return `${kind}_${uuid}`;
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      id = factory(prefix, new Set([...used, ...retired]));
      if (typeof id === 'string' && !used.has(id) && !retired.has(id)) break;
      id = undefined;
    }
  }
  if (typeof id !== 'string' || used.has(id) || retired.has(id)) {
    throw new Error(`${prefix}の新しいIDを発行できません`);
  }
  return id;
}

function positionIndex(items, id, label) {
  const index = items.findIndex(item => item.id === id);
  if (index < 0) throw new Error(`${label}がありません: ${id}`);
  return index;
}

function insertAfter(items, item, afterId, label) {
  if (afterId === null) {
    items.unshift(item);
    return;
  }
  if (afterId === undefined) {
    items.push(item);
    return;
  }
  const index = positionIndex(items, afterId, label);
  items.splice(index + 1, 0, item);
}

function canonicalizePaths(manifest) {
  const next = clone(manifest);
  next.episodes.forEach((episode, episodeIndex) => {
    episode.scenes.forEach((scene, sceneIndex) => {
      scene.path = scenePathFor(episodeIndex + 1, sceneIndex + 1, {
        episodeCount: next.episodes.length,
        sceneCount: episode.scenes.length,
      });
    });
  });
  return next;
}

function makeFilePlan(before, after, operation, removedIds = []) {
  const oldScenes = sceneEntries(before);
  const newScenes = sceneEntries(after);
  const renamed = [];
  const created = [];
  const removed = [];

  for (const [id, scene] of newScenes) {
    const previous = oldScenes.get(id);
    if (!previous) created.push({ id, to: scene.path, reason: operation });
    else if (previous.path !== scene.path) renamed.push({ id, from: previous.path, to: scene.path, reason: operation });
  }
  for (const [id, scene] of oldScenes) {
    if (!newScenes.has(id)) removed.push({ id, from: scene.path, reason: operation });
  }

  // All old paths are staged before any target path is written. This handles
  // swaps and insertions without allowing one rename to overwrite another.
  const stageMoves = renamed.map((move, index) => ({
    ...move,
    staging: `__story_source_staging__/${String(index + 1).padStart(4, '0')}.md`,
  }));
  return {
    renames: renamed,
    creates: created,
    removes: removed,
    stageMoves,
    finalMoves: stageMoves.map(({ id, to, staging, reason }) => ({ id, from: staging, to, reason })),
    retiredIds: [...new Set([...removedIds, ...removed.map(entry => entry.id)])],
  };
}

function makePlan(before, after, operation, { retiredIds = [], afterRetiredIds = retiredIds } = {}) {
  const beforeModel = validateManifest(before, { retiredIds });
  const afterModel = validateManifest(after, { retiredIds: afterRetiredIds });
  const filePlan = makeFilePlan(beforeModel, afterModel, operation, afterRetiredIds);
  const changed = JSON.stringify(beforeModel) !== JSON.stringify(afterModel);
  const affectedSceneIds = [...new Set([
    ...filePlan.renames.map(entry => entry.id),
    ...filePlan.creates.map(entry => entry.id),
    ...filePlan.removes.map(entry => entry.id),
  ])];
  return {
    version: 1,
    format: FORMAT,
    operation,
    changed,
    before: beforeModel,
    after: afterModel,
    affectedSceneIds,
    filePlan,
  };
}

function retired(options) {
  return Array.isArray(options.retiredIds) ? [...new Set(options.retiredIds)] : [];
}

export function planReindex(manifest, options = {}) {
  const base = validateManifest(manifest, { retiredIds: retired(options) });
  return makePlan(base, canonicalizePaths(base), 'reindex', { retiredIds: retired(options) });
}

export function planAddScene(manifest, {
  episodeId,
  afterSceneId,
  sceneId,
  tags,
  idFactory,
  retiredIds = [],
} = {}) {
  const base = validateManifest(manifest, { retiredIds });
  const next = clone(base);
  const episode = next.episodes.find(item => item.id === episodeId);
  if (!episode) throw new Error(`話がありません: ${episodeId}`);
  if (afterSceneId !== undefined && afterSceneId !== null && !episode.scenes.some(scene => scene.id === afterSceneId)) {
    throw new Error(`追加位置の場面がありません: ${afterSceneId}`);
  }
  const id = newId('sc', base, sceneId, idFactory, retiredIds);
  if (tags !== undefined && !Array.isArray(tags)) throw new Error('タグは配列が必要です');
  const scene = { id, ...(tags === undefined ? {} : { tags: [...tags] }) };
  insertAfter(episode.scenes, scene, afterSceneId, '追加位置の場面');
  return makePlan(base, canonicalizePaths(next), 'add-scene', { retiredIds });
}

export function planMoveScene(manifest, {
  sceneId,
  targetEpisodeId,
  afterSceneId,
  retiredIds = [],
} = {}) {
  const base = validateManifest(manifest, { retiredIds });
  const next = clone(base);
  const sourceEpisode = next.episodes.find(episode => episode.scenes.some(scene => scene.id === sceneId));
  if (!sourceEpisode) throw new Error(`場面がありません: ${sceneId}`);
  const targetEpisode = next.episodes.find(episode => episode.id === targetEpisodeId);
  if (!targetEpisode) throw new Error(`移動先の話がありません: ${targetEpisodeId}`);
  if (afterSceneId === sceneId) throw new Error('移動元と同じ場面の直後には移動できません');
  if (afterSceneId !== undefined && afterSceneId !== null && !targetEpisode.scenes.some(scene => scene.id === afterSceneId && scene.id !== sceneId)) {
    throw new Error(`移動位置の場面がありません: ${afterSceneId}`);
  }
  const index = positionIndex(sourceEpisode.scenes, sceneId, '場面');
  const [scene] = sourceEpisode.scenes.splice(index, 1);
  insertAfter(targetEpisode.scenes, scene, afterSceneId, '移動位置の場面');
  return makePlan(base, canonicalizePaths(next), 'move-scene', { retiredIds });
}

export function planRemoveScene(manifest, { sceneId, retiredIds = [] } = {}) {
  const base = validateManifest(manifest, { retiredIds });
  const next = clone(base);
  const episode = next.episodes.find(item => item.scenes.some(scene => scene.id === sceneId));
  if (!episode) throw new Error(`場面がありません: ${sceneId}`);
  episode.scenes = episode.scenes.filter(scene => scene.id !== sceneId);
  const nextRetiredIds = [...new Set([...retiredIds, sceneId])];
  return makePlan(base, canonicalizePaths(next), 'remove-scene', { retiredIds, afterRetiredIds: nextRetiredIds });
}

export function planAddEpisode(manifest, {
  episodeId,
  title,
  afterEpisodeId,
  initialScenes = [],
  idFactory,
  retiredIds = [],
} = {}) {
  const base = validateManifest(manifest, { retiredIds });
  if (typeof title !== 'string' || !title.trim()) throw new Error('話タイトルが必要です');
  const next = clone(base);
  const id = newId('ep', base, episodeId, idFactory, retiredIds);
  const used = allIds(base);
  const scenes = initialScenes.map((scene, index) => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error(`初期場面が不正です: ${index}`);
    if (scene.tags !== undefined && !Array.isArray(scene.tags)) throw new Error(`初期場面のタグが不正です: ${index}`);
    const sceneId = newId('sc', { ...base, episodes: [...base.episodes, ...next.episodes.map(item => ({ ...item, scenes: item.scenes }))] }, scene.id, idFactory, retiredIds);
    if (used.has(sceneId)) throw new Error(`場面IDが重複しています: ${sceneId}`);
    used.add(sceneId);
    return { id: sceneId, ...(scene.tags === undefined ? {} : { tags: [...scene.tags] }) };
  });
  const episode = { id, title, scenes };
  insertAfter(next.episodes, episode, afterEpisodeId, '追加位置の話');
  return makePlan(base, canonicalizePaths(next), 'add-episode', { retiredIds });
}

export function planMoveEpisode(manifest, { episodeId, afterEpisodeId, retiredIds = [] } = {}) {
  const base = validateManifest(manifest, { retiredIds });
  const next = clone(base);
  if (afterEpisodeId === episodeId) throw new Error('移動元と同じ話の直後には移動できません');
  const index = positionIndex(next.episodes, episodeId, '話');
  if (afterEpisodeId !== undefined && afterEpisodeId !== null && !next.episodes.some(episode => episode.id === afterEpisodeId && episode.id !== episodeId)) {
    throw new Error(`移動位置の話がありません: ${afterEpisodeId}`);
  }
  const [episode] = next.episodes.splice(index, 1);
  insertAfter(next.episodes, episode, afterEpisodeId, '移動位置の話');
  return makePlan(base, canonicalizePaths(next), 'move-episode', { retiredIds });
}

export function planRemoveEpisode(manifest, { episodeId, retiredIds = [] } = {}) {
  const base = validateManifest(manifest, { retiredIds });
  if (base.episodes.length <= 1) throw new Error('作品には1件以上の話が必要です');
  const next = clone(base);
  const index = positionIndex(next.episodes, episodeId, '話');
  const [removed] = next.episodes.splice(index, 1);
  const nextRetiredIds = [...new Set([
    ...retiredIds,
    removed.id,
    ...removed.scenes.map(scene => scene.id),
  ])];
  return makePlan(base, canonicalizePaths(next), 'remove-episode', { retiredIds, afterRetiredIds: nextRetiredIds });
}

export function planStructureChange(manifest, operation, options = {}) {
  switch (operation) {
    case 'reindex': return planReindex(manifest, options);
    case 'add-scene': return planAddScene(manifest, options);
    case 'move-scene': return planMoveScene(manifest, options);
    case 'remove-scene': return planRemoveScene(manifest, options);
    case 'add-episode': return planAddEpisode(manifest, options);
    case 'move-episode': return planMoveEpisode(manifest, options);
    case 'remove-episode': return planRemoveEpisode(manifest, options);
    default: throw new Error(`未知の構造操作です: ${operation}`);
  }
}
