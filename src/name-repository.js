import { call } from './bridge.js';
import { safePath } from './core.js';
import { FORMAT, MAX_BYTES } from '../contracts/name-plan/schema.mjs';
import { atomize, selectAtoms, hasEmbeddedSource } from '../contracts/name-plan/source.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const episodes = snapshot => snapshot.episodeIds ?? (snapshot.episodeId ? [snapshot.episodeId] : []);

export function repositoryNamePlanPath(snapshot, episodeId, number = null) {
  if (!REPO.test(snapshot?.repo ?? '') || !/^[0-9a-f]{40}$/i.test(snapshot?.sha ?? '')) throw Error('原稿のGitHub版が確定していません');
  if (!ID.test(episodeId ?? '')) throw Error('話IDが不正です');
  const allowed = episodes(snapshot);
  if (!Array.isArray(allowed) || !allowed.includes(episodeId)) throw Error('取り込んだ原稿にない話のネームは取得できません');
  const root = snapshot.library?.root ?? snapshot.sync?.source_root ?? (snapshot.embeddedName ? `works/${snapshot.workId}` : '');
  if (typeof root !== 'string' || /[\x00-\x1f\x7f]/.test(root)) throw Error('作品rootが不正です');
  if (number !== null && (!Number.isSafeInteger(number) || number < 1 || number > 999999)) throw Error('ネーム番号が不正です');
  return safePath([root, 'manga', episodeId, number === null ? 'name-plan.json' : `name-${String(number).padStart(3,'0')}.json`].filter(Boolean).join('/'));
}

export async function fetchRepositoryNamePlan(snapshot, episodeId, token, invokeCall = call, number = null) {
  // Capture the retrieval identity before I/O; never relabel a response using a later HEAD.
  const target = { path: repositoryNamePlanPath(snapshot, episodeId, number), commit: snapshot.sha, repo: snapshot.repo, episodeId,
    ...(number === null ? {} : { number, workId:snapshot.workId, root:snapshot.library?.root ?? snapshot.sync?.source_root ?? `works/${snapshot.workId}` }) };
  const raw = await invokeCall('github_file', { repo: target.repo, path: target.path, sha: target.commit, token });
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BYTES) throw Error('GitHubのネームJSONは4MiB以内で指定してください');
  return { raw, ...target };
}

// Transport scope supplements, but never replaces, the shared importer validators.
// Read-only context may cross episodes; the primary adapted atoms may not.
export function validateRepositoryNameTarget(project, file, target) {
  const snapshot = project.snapshots.find(s => s.id === project.active);
  if (hasEmbeddedSource(file)) {
    if (file.source.repo !== target.repo || file.source.workId !== (target.workId ?? project.workId)
      || file.source.episodeId !== target.episodeId || (target.number != null && file.source.number !== target.number)
      || (project.workId && project.workId !== file.source.workId)) throw Error('取得したネームの作品・話・番号が異なります');
    const context = {repo:target.repo,sha:target.commit,episodeIds:[target.episodeId],library:{root:target.root ?? snapshot?.library?.root ?? snapshot?.sync?.source_root ?? ''}};
    if (target.path !== repositoryNamePlanPath(context,target.episodeId,target.number??null)) throw Error('ネームの取得パスが不正です');
    return;
  }
  if (!snapshot || target.repo !== snapshot.repo || target.commit !== snapshot.sha ||
      target.path !== repositoryNamePlanPath(snapshot, target.episodeId)) throw Error('取得したネームの作品・原稿版が変わりました');
  if (file?.source?.repo !== snapshot.repo || file.source.workId !== (snapshot.workId ?? project.workId)) throw Error('別作品のネームは取り込めません');
  const allowed = episodes(snapshot);
  const inEpisode = sceneId => {
    const scene = snapshot.scenes.find(s => s.id === sceneId);
    return !!scene && (scene.episodeId ?? (allowed.length === 1 ? allowed[0] : null)) === target.episodeId;
  };
  if (file.format === FORMAT) {
    const selected = selectAtoms(atomize(snapshot), file.source.selectedAtomIds);
    if (selected.some(atom => !inEpisode(atom.source.sceneId))) throw Error('ネームの対象原稿が取得した話と異なります');
  } else {
    if (file.source.episodeId !== target.episodeId || !Array.isArray(file.source.scenes) ||
        file.source.scenes.some(scene => !inEpisode(scene.id))) throw Error('ネームの対象原稿が取得した話と異なります');
  }
}
