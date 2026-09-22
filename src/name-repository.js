import { call } from './bridge.js';
import { safePath } from './core.js';
import { MAX_BYTES } from '../contracts/name-plan/schema.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;

export function repositoryNamePlanPath(snapshot, episodeId) {
  if (!snapshot?.repo || !/^[0-9a-f]{40}$/i.test(snapshot.sha ?? '')) throw Error('原稿のGitHub版が確定していません');
  if (!ID.test(episodeId ?? '')) throw Error('話IDが不正です');
  const allowed=new Set(snapshot.episodeIds??(snapshot.episodeId?[snapshot.episodeId]:[]));
  if (!allowed.has(episodeId)) throw Error('取り込んだ原稿にない話のネームは取得できません');
  const root=snapshot.library?.root ?? snapshot.sync?.source_root ?? '';
  return safePath([root,'manga',episodeId,'name-plan.json'].filter(Boolean).join('/'));
}

export async function fetchRepositoryNamePlan(snapshot, episodeId, token, invokeCall=call) {
  const path=repositoryNamePlanPath(snapshot,episodeId);
  const raw=await invokeCall('github_file',{repo:snapshot.repo,path,sha:snapshot.sha,token});
  if (typeof raw!=='string' || new TextEncoder().encode(raw).length>MAX_BYTES) throw Error('GitHubのネームJSONは4MiB以内で指定してください');
  return {raw,path,commit:snapshot.sha,repo:snapshot.repo,episodeId};
}
