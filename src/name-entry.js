import { parseNameFile } from '../contracts/name-plan/schema.mjs';
import { hasEmbeddedSource, bindEmbeddedSource } from '../contracts/name-plan/source.mjs';
import { createNameCandidate } from './name-v2.js';

// Both the empty-workspace entry and subsequent additions use this path.
export async function stageEmbeddedName(project, raw, repositoryPlan = null) {
  if(repositoryPlan){const {raw:transportRaw,...provenance}=repositoryPlan;repositoryPlan=provenance;}
  const file = parseNameFile(raw);
  if (!hasEmbeddedSource(file)) throw Error('原文入りの番号付きネームを書き出してください。旧形式には当時の原稿が必要です');
  const { snapshot } = await bindEmbeddedSource(file, project);
  if(repositoryPlan?.root)snapshot.library={root:repositoryPlan.root};
  const base = { ...project, workId: file.source.workId,
    title: project.active ? project.title : file.title,
    active: project.active || snapshot.id,
    snapshots: project.snapshots.some(s => s.id === snapshot.id) ? project.snapshots : [...project.snapshots, snapshot],
    layout: project.layout ?? {version:1,pages:[],knownPanelIds:[]},
    sourceApplication: project.sourceApplication ?? {version:1,units:[]},
  };
  const candidate = await createNameCandidate(base, file);
  const job = { id: crypto.randomUUID(), kind:'name_plan', status:'candidate', source_revision:snapshot.id,
    nameCandidate:candidate, ...(repositoryPlan?{repositoryPlan}:{}), at:new Date().toISOString() };
  return { ...base, jobs:[...base.jobs, job] };
}
