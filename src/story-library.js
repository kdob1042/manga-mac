import { validateCatalog, findWork, importedWorks } from '../contracts/story-library/catalog.mjs';
import { validateSourceMap } from '../contracts/story-library/source-map.mjs';
import { assertWorkRoot, joinWorkPath, manifestEntryPath } from '../contracts/story-library/paths.mjs';
import { normalizeSourceManifest } from './source-protocol.js';

export const LIBRARY_FORMAT = 'story-library/v1';
export const DEFAULT_STORY_LIBRARY_REPO = 'kdob1042/story-library';
const SHA = /^[a-f0-9]{40}$/;

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw Error(label + 'のJSONを解析できません');
  }
}

function commitFrom(value) {
  const sha = parseJson(value, 'commit').sha;
  if (!SHA.test(sha)) throw Error('story-libraryのmain commitが不正です');
  return sha;
}

export function validateLibraryCatalog(value) {
  return validateCatalog(value);
}

export function availableStoryWorks(catalog, format = 'manga') {
  return importedWorks(catalog).filter(work => work.formats.includes(format));
}

export function findLibraryWork(catalog, workId) {
  return findWork(catalog, workId);
}

export function libraryManifestLocation(work) {
  assertWorkRoot(work.root);
  return {
    root: work.root,
    manifestPath: manifestEntryPath(work.root),
    sourceRoot: work.root,
  };
}

export function libraryFilePath(work, relativePath) {
  return joinWorkPath(work.root, relativePath);
}

export function manifestOutline(manifest) {
  const model = normalizeSourceManifest(manifest);
  const scenes = new Map((model.scenes ?? []).map(scene => [scene.id, scene]));
  return (model.episodes ?? []).map(episode => ({
    id: episode.id,
    title: episode.title ?? episode.id,
    chapterId: episode.chapterId ?? null,
    chapterTitle: episode.chapterTitle ?? null,
    scenes: (episode.scene_ids ?? episode.scenes?.map(scene => scene.id) ?? [])
      .map(id => scenes.get(id))
      .filter(Boolean)
      .map(scene => ({id: scene.id, title: scene.title ?? scene.id, tags: scene.tags ?? []})),
  }));
}

export async function fetchStoryLibrary(repo, token, invokeCall) {
  if (typeof invokeCall !== 'function') throw Error('GitHub接続が必要です');
  const sha = commitFrom(await invokeCall('github_get', {repo, path: 'commits/main', token}));
  const [catalogText, sourceMapText] = await Promise.all([
    invokeCall('github_file', {repo, path: 'library.json', sha, token}),
    invokeCall('github_file', {repo, path: 'migrations/source-map.json', sha, token}),
  ]);
  const catalog = validateCatalog(parseJson(catalogText, 'library.json'));
  const sourceMap = validateSourceMap(parseJson(sourceMapText, 'migrations/source-map.json'), {
    catalogWorkIds: new Set(catalog.works.map(work => work.id)),
  });
  return {repo, sha, catalog, sourceMap};
}

export async function fetchStoryLibraryWork(library, workId, token, invokeCall) {
  if (!library?.repo || !SHA.test(library.sha)) throw Error('catalogの取得版がありません');
  const work = findWork(library.catalog, workId);
  if (!work || !importedWorks(library.catalog).some(item => item.id === workId)) {
    throw Error('選択した作品はstory-libraryの制作対象ではありません');
  }
  const location = libraryManifestLocation(work);
  const text = await invokeCall('github_file', {
    repo: library.repo,
    path: location.manifestPath,
    sha: library.sha,
    token,
  });
  const manifest = parseJson(text, location.manifestPath);
  return {
    ...library,
    work,
    manifest,
    outline: manifestOutline(manifest),
    manifestPath: location.manifestPath,
    sourceRoot: location.sourceRoot,
    sourceMapEntry: library.sourceMap?.entries.find(entry => entry.workId === workId) ?? null,
  };
}
