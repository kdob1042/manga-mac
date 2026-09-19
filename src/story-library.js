import { safePath } from './core.js';

export const LIBRARY_FORMAT = 'story-library/v1';

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/i;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${label}が不正です`);
  return value;
}

function id(value, label) {
  const result = text(value, label, 128);
  if (!ID.test(result)) throw Error(`${label}が不正です`);
  return result;
}

function relativePath(value, label) {
  const result = text(value, label, 400);
  safePath(result);
  return result;
}

function repository(value, label) {
  const result = text(value, label, 200);
  if (!REPOSITORY.test(result)) throw Error(`${label}が不正です`);
  return result;
}

function commit(value, label) {
  const result = text(value, label, 40);
  if (!SHA.test(result)) throw Error(`${label}が不正です`);
  return result;
}

function manifestLocation(work) {
  const root = relativePath(work.root, '作品root');
  if (!root.startsWith('works/')) throw Error('作品rootはworks/配下である必要があります');
  const relative = relativePath(work.origin?.manifestPath, 'manifestの場所');
  const manifestPath = `${root}/${relative}`;
  const sourceRoot = manifestPath.split('/').slice(0, -1).join('/');
  return {root, manifestPath, sourceRoot};
}

export function validateLibraryCatalog(value) {
  if (!record(value) || value.format !== LIBRARY_FORMAT || !Array.isArray(value.works)) {
    throw Error(`原稿catalogは${LIBRARY_FORMAT}の配列が必要です`);
  }
  const workIds = new Set();
  const roots = new Set();
  const works = value.works.map((work, index) => {
    const path = `works[${index}]`;
    if (!record(work)) throw Error(`${path}が不正です`);
    const normalized = {
      ...work,
      id: id(work.id, `${path}.id`),
      title: text(work.title, `${path}.title`, 200),
      root: relativePath(work.root, `${path}.root`),
      formats: Array.isArray(work.formats) ? [...work.formats] : [],
      readAdapters: Array.isArray(work.readAdapters) ? [...work.readAdapters] : [],
      manuscriptFormat: text(work.manuscriptFormat, `${path}.manuscriptFormat`, 200),
      origin: record(work.origin) ? {
        ...work.origin,
        repository: repository(work.origin.repository, `${path}.origin.repository`),
        ref: text(work.origin.ref, `${path}.origin.ref`, 100),
        commit: commit(work.origin.commit, `${path}.origin.commit`),
        manifestPath: relativePath(work.origin.manifestPath, `${path}.origin.manifestPath`),
        ...(work.origin.structureCommit === undefined ? {} : {structureCommit: commit(work.origin.structureCommit, `${path}.origin.structureCommit`)}),
        ...(work.origin.accessible === undefined ? {} : {accessible: work.origin.accessible === true}),
      } : null,
    };
    if (!normalized.root.startsWith('works/')) throw Error(`${path}.rootはworks/配下である必要があります`);
    if (!normalized.formats.length || normalized.formats.some(format => typeof format !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(format))) {
      throw Error(`${path}.formatsが不正です`);
    }
    if (!normalized.origin) throw Error(`${path}.originが不正です`);
    if (workIds.has(normalized.id)) throw Error(`作品IDが重複しています: ${normalized.id}`);
    if (roots.has(normalized.root)) throw Error(`作品rootが重複しています: ${normalized.root}`);
    workIds.add(normalized.id);
    roots.add(normalized.root);
    manifestLocation(normalized);
    return normalized;
  });
  return {...value, works};
}

export function findLibraryWork(catalog, workId) {
  return (catalog?.works ?? []).find(work => work.id === workId) ?? null;
}

export function libraryManifestLocation(work) {
  return manifestLocation(work);
}

export function manifestOutline(manifest) {
  if (!record(manifest)) throw Error('原稿manifestが不正です');
  if (manifest.format === 'story-source/v1') {
    if (!Array.isArray(manifest.episodes)) throw Error('話の定義が不正です');
    return manifest.episodes.map(episode => ({
      id: id(episode.id, '話ID'),
      title: text(episode.title, '話タイトル', 200),
      chapterId: null,
      chapterTitle: null,
      scenes: (Array.isArray(episode.scenes) ? episode.scenes : []).map(scene => ({
        id: id(scene.id, '場面ID'),
        title: scene.title ?? scene.id,
      })),
    }));
  }
  if (manifest.format === 'investor-life-source/v1') {
    if (!Array.isArray(manifest.chapters)) throw Error('章の定義が不正です');
    return manifest.chapters.flatMap(chapter => {
      const chapterId = id(chapter.id, '章ID');
      const chapterTitle = text(chapter.title, '章タイトル', 200);
      if (!Array.isArray(chapter.episodes)) throw Error('話の定義が不正です');
      return chapter.episodes.map(episode => ({
        id: id(episode.id, '話ID'),
        title: text(episode.title, '話タイトル', 200),
        chapterId,
        chapterTitle,
        scenes: [{id: id(episode.id, '場面ID'), title: text(episode.title, '話タイトル', 200)}],
      }));
    });
  }
  throw Error(`原稿形式 ${manifest.format ?? '不明'} はcatalogのread adapterが未対応です`);
}

export async function fetchStoryLibrary(repo, token, invokeCall) {
  if (!REPOSITORY.test(repo)) throw Error('owner/repository の形式で指定してください');
  if (typeof invokeCall !== 'function') throw Error('GitHub接続が必要です');
  const commitResponse = await invokeCall('github_get', {repo, path: 'commits/main', token});
  const parsed = JSON.parse(commitResponse);
  const sha = commit(parsed?.sha, 'catalogの取得commit');
  const textValue = await invokeCall('github_file', {repo, path: 'library.json', sha, token});
  if (typeof textValue !== 'string' || textValue.length > 2 * 1024 * 1024) throw Error('catalogが大きすぎます');
  return {repo, sha, catalog: validateLibraryCatalog(JSON.parse(textValue))};
}

export async function fetchStoryLibraryWork(library, workId, token, invokeCall) {
  if (!library?.repo || !SHA.test(library.sha)) throw Error('catalogの取得版がありません');
  const work = findLibraryWork(library.catalog, workId);
  if (!work) throw Error('作品が見つかりません');
  const {manifestPath, sourceRoot} = manifestLocation(work);
  const textValue = await invokeCall('github_file', {repo: library.repo, path: manifestPath, sha: library.sha, token});
  if (typeof textValue !== 'string' || textValue.length > 4 * 1024 * 1024) throw Error('manifestが大きすぎます');
  const manifest = JSON.parse(textValue);
  const outline = manifestOutline(manifest);
  return {work, manifest, outline, manifestPath, sourceRoot};
}
