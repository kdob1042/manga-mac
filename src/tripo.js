import { call, loadProject } from './bridge.js';

export const TRIPO_MODEL = 'v2.5-20250123';

function imageInput(character) {
  if (!character?.image || !/^[0-9a-f]{64}$/.test(character.hash ?? '') || !/^data:image\/(png|jpeg|webp);base64,/.test(character.image)) {
    throw Error('Tripoへ送る人物参照画像がありません');
  }
  return { image: character.image, hash: character.hash };
}

export function beginTripoJob(project, { characterId, prompt = '' }) {
  const character = project.characters?.find(item => item.id === characterId);
  if (!character) throw Error('生成対象の人物を選択してください');
  const input = imageInput(character);
  const id = crypto.randomUUID();
  const job = {
    id,
    kind: 'tripo_model',
    status: 'prepared',
    scope: { type: 'tripoModel', id },
    panelId: null,
    input_hash: character.hash,
    manifest: {
      version: 1,
      provider: 'tripo',
      model: TRIPO_MODEL,
      mode: 'image_to_model',
      source: { character_id: character.id, snapshot_id: project.active, character_version: character.version ?? null },
      image: input,
      prompt: String(prompt).slice(0, 1000)
    },
    remote: { provider: 'tripo', model: TRIPO_MODEL, status: 'prepared', input_hash: character.hash }
  };
  return { ...project, jobs: [...(project.jobs ?? []), job] };
}

export async function submitTripoJob(project, jobId, connectionId) {
  await call('tripo_submit', { jobId, connectionId });
  return loadProject();
}

export async function updateTripoJob(project, jobId, connectionId) {
  await call('tripo_task', { jobId, connectionId, action: 'status' });
  return loadProject();
}

export async function collectTripoJob(project, jobId, connectionId, directoryWork, scope) {
  const artifact = await call('tripo_task', {
    jobId, connectionId, action: 'collect', directoryWork, scope
  });
  const next = await loadProject();
  return { project: next, artifact };
}

export function tripoJobs(project) {
  return (project.jobs ?? []).filter(job => job.scope?.type === 'tripoModel');
}
