import { call, loadProject } from './bridge.js';
import { registerSceneAsset } from './scene-assets.js';

export const TRIPO_MODEL = 'v2.5-20250123';

function imageInput(character) {
  if (!character?.image || !/^[0-9a-f]{64}$/.test(character.hash ?? '') || !/^data:image\/(png|jpeg|webp);base64,/.test(character.image)) {
    throw Error('Tripoへ送る人物参照画像がありません');
  }
  return { image: character.image, hash: character.hash };
}

export function beginTripoJob(project, { characterId, reference, kind = 'character', name, prompt = '' }) {
  const character = characterId ? project.characters?.find(item => item.id === characterId) : null;
  if (!character && (!reference || !['environment', 'prop'].includes(kind))) throw Error('生成対象の参照画像を選択してください');
  if (!character && (typeof name !== 'string' || !name.trim() || name.trim().length > 100)) throw Error('素材名を入力してください');
  const input = imageInput(character ?? reference);
  const id = crypto.randomUUID();
  const job = {
    id,
    kind: 'tripo_model',
    status: 'prepared',
    scope: { type: 'tripoModel', id },
    panelId: null,
    input_hash: input.hash,
    manifest: {
      version: 1,
      provider: 'tripo',
      model: TRIPO_MODEL,
      mode: 'image_to_model',
      source: character ? { character_id: character.id, snapshot_id: project.active, character_version: character.version ?? null }
        : { asset_kind: kind, asset_name: String(name ?? '').trim().slice(0, 100), snapshot_id: project.active },
      image: input,
      prompt: String(prompt).slice(0, 1000)
    },
    remote: { provider: 'tripo', model: TRIPO_MODEL, status: 'prepared', input_hash: input.hash }
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

export async function collectTripoJob(project, jobId, connectionId) {
  const artifact = await call('tripo_task', {
    jobId, connectionId, action: 'collect'
  });
  const next = await loadProject();
  const job = next.jobs?.find(item => item.id === jobId);
  if (!job) throw Error('回収したモデルの生成要求がありません');
  const source = job.manifest?.source ?? {};
  const character = next.characters?.find(item => item.id === source.character_id);
  const kind = source.character_id ? 'character' : source.asset_kind;
  const name = source.character_id ? (character?.name ?? `人物 ${source.character_id}`) : source.asset_name;
  const registered = registerSceneAsset(next, { ...artifact, kind, name, source: 'tripo' });
  return { ...registered, artifact };
}

export function tripoJobs(project) {
  return (project.jobs ?? []).filter(job => job.scope?.type === 'tripoModel');
}
