import { validateCatalog, findWork, importedWorks } from '../contracts/story-library/catalog.mjs';
import { validateSourceMap } from '../contracts/story-library/source-map.mjs';
import { assertWorkRoot, joinWorkPath, legacyManifestEntryPath, workEntryPath } from '../contracts/story-library/paths.mjs';
import { normalizeSourceManifest } from './source-protocol.js';

export const LIBRARY_FORMAT = 'story-library/v1';
export const DEFAULT_STORY_LIBRARY_REPO = 'kdob1042/story-library';
export const SOURCE_BRANCHES = ['dev', 'main'];
const SHA = /^[a-f0-9]{40}$/;

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw Error(label + 'のJSONを解析できません');
  }
}

export function sourceBranch(value = 'main') {
  if (!SOURCE_BRANCHES.includes(value)) throw Error('原稿ブランチはdevまたはmainを選んでください');
  return value;
}

export async function fetchSourceHead(repo, token, invokeCall, branch = 'main') {
  const selectedBranch = sourceBranch(branch);
  const head = parseJson(await invokeCall('github_get', {repo, path: `commits/${selectedBranch}`, token}), 'commit');
  if (!SHA.test(head.sha)) throw Error(`story-libraryの${selectedBranch} commitが不正です`);
  return {sha:head.sha, transport:head.transport === 'local' ? 'local' : 'github'};
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
    entryPath: workEntryPath(work.root),
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

export async function fetchStoryLibrary(repo, token, invokeCall, branch = 'main') {
  if (typeof invokeCall !== 'function') throw Error('GitHub接続が必要です');
  const selectedBranch = sourceBranch(branch);
  const {sha, transport} = await fetchSourceHead(repo, token, invokeCall, selectedBranch);
  const [catalogText, sourceMapText] = await Promise.all([
    invokeCall('github_file', {repo, path: 'library.json', sha, token}),
    invokeCall('github_file', {repo, path: 'migrations/source-map.json', sha, token}),
  ]);
  const catalog = validateCatalog(parseJson(catalogText, 'library.json'));
  const sourceMap = validateSourceMap(parseJson(sourceMapText, 'migrations/source-map.json'), {
    catalogWorkIds: new Set(catalog.works.map(work => work.id)),
    catalogWorks: catalog.works,
  });
  return {repo, branch:selectedBranch, sha, transport, catalog, sourceMap};
}

export async function fetchStoryLibraryWork(library, workId, token, invokeCall) {
  if (!library?.repo || !SHA.test(library.sha)) throw Error('catalogの取得版がありません');
  const work = findWork(library.catalog, workId);
  if (!work || !importedWorks(library.catalog).some(item => item.id === workId)) {
    throw Error('選択した作品はstory-libraryの制作対象ではありません');
  }
  const location = libraryManifestLocation(work);
  let entryPath = location.entryPath;
  let text;
  try {
    text = await invokeCall('github_file', {
      repo: library.repo,
      path: entryPath,
      sha: library.sha,
      token,
    });
  } catch (error) {
    const legacyPath = legacyManifestEntryPath(work.root);
    if (entryPath === legacyPath) throw error;
    entryPath = legacyPath;
    text = await invokeCall('github_file', {
      repo: library.repo,
      path: entryPath,
      sha: library.sha,
      token,
    });
  }
  const manifest = parseJson(text, entryPath);
  return {
    ...library,
    work,
    manifest,
    outline: manifestOutline(manifest),
    entryPath,
    sourceRoot: location.sourceRoot,
    sourceMapEntry: library.sourceMap?.entries.find(entry => entry.workId === workId) ?? null,
  };
}
