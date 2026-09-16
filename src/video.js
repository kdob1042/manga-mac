// Video domain records reuse the existing source, artwork, capture and jobs.
// No network requests, second asset registry or embedded video bytes here.
import { sourceUnits } from './core.js';
import { digest, imageHash } from './revisions.js';

const ratios = ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'];
const hashPattern = /^[0-9a-f]{64}$/;
const hashValue = value => digest(new TextEncoder().encode(JSON.stringify(value)));
function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw Error('未対応の動画入力です');
}

export function validateVideoShot(project, shot) {
  exactKeys(shot, ['id', 'snapshotId', 'sceneId', 'unitIds', 'characterIds', 'startImage', 'prompt', 'duration', 'ratio', 'adopted_revision']);
  const snapshot = project.snapshots.find(s => s.id === shot.snapshotId);
  const scene = snapshot?.scenes.find(s => s.id === shot.sceneId);
  if (!scene || typeof shot.id !== 'string' || !shot.id) throw Error('動画の原作参照がありません');
  const units = sourceUnits(scene.id, scene.text).map(u => u.id);
  if (!Array.isArray(shot.unitIds) || !shot.unitIds.length || new Set(shot.unitIds).size !== shot.unitIds.length || JSON.stringify(units.filter(id => shot.unitIds.includes(id))) !== JSON.stringify(shot.unitIds)) throw Error('原文の範囲・順序が不正です');
  if (!Array.isArray(shot.characterIds) || new Set(shot.characterIds).size !== shot.characterIds.length || shot.characterIds.some(id => !project.characters.some(c => c.id === id))) throw Error('動画の人物参照が不正です');
  if (typeof shot.prompt !== 'string' || !shot.prompt.trim() || shot.prompt.length > 1000 || shot.duration !== 5 || !ratios.includes(shot.ratio)) throw Error('動画の指示・尺・寸法が未対応です');
  exactKeys(shot.startImage, ['kind', 'id', 'hash']);
  if (!['artwork', 'capture'].includes(shot.startImage.kind) || typeof shot.startImage.id !== 'string' || !hashPattern.test(shot.startImage.hash)) throw Error('開始画像の不変参照が必要です');
  return shot;
}

// loadCapture is the existing blender_capture IPC, supplied at the UI boundary.
export async function resolveStartImage(project, reference, loadCapture) {
  exactKeys(reference, ['kind', 'id', 'hash']);
  let image, dependencies;
  if (reference.kind === 'artwork') {
    const artwork = project.artworks.find(a => a.id === reference.id);
    if (!artwork || artwork.hash !== reference.hash) throw Error('開始作画版がありません');
    image = artwork.panel.image;
    dependencies = { artwork_revision: artwork.id, capture_revision: artwork.capture_revision,
      references: structuredClone(artwork.panel.references ?? []) };
  } else if (reference.kind === 'capture') {
    const capture = project.captures?.find(c => c.id === reference.id);
    if (!capture?.dependencies_pinned || capture.image.hash !== reference.hash || !hashPattern.test(capture.checkpoint.hash) || typeof loadCapture !== 'function') throw Error('固定撮影版がありません');
    const response = await loadCapture(capture.session_id, capture.request_id);
    if (response.session_id !== capture.session_id || response.request_id !== capture.request_id || response.state?.checkpoint?.hash !== capture.checkpoint.hash || response.state?.image?.hash !== capture.image.hash || !response.state.dependencies_pinned) throw Error('保存済み撮影版が一致しません');
    image = response.preview;
    dependencies = { capture_revision: capture.id, checkpoint_hash: capture.checkpoint.hash,
      character_bindings: structuredClone(capture.character_bindings ?? []) };
  } else throw Error('未対応の開始画像です');
  if (await imageHash(image) !== reference.hash) throw Error('開始画像のハッシュが一致しません');
  // This limit applies to the decoded input, before building a provider Data URI.
  const size = atob(image.split(',')[1]).length;
  if (size > 5_000_000) throw Error('開始画像は5MB以下にしてください');
  return { image, artifact: { id: reference.id, hash: reference.hash, media_type: 'image', mime: image.slice(5, image.indexOf(';')), size }, sourceDependencies: dependencies };
}

export function createVideoShot(project, options) {
  const shot = validateVideoShot(project, { ...options, id: crypto.randomUUID(), adopted_revision: null });
  return { ...project, videoShots: [...project.videoShots, structuredClone(shot)] };
}

export async function videoManifest(project, shot, connection, loadCapture) {
  validateVideoShot(project, shot);
  exactKeys(connection, ['id', 'provider', 'model']);
  if (typeof connection.id !== 'string' || !connection.id || connection.provider !== 'runway' || connection.model !== 'gen4.5') throw Error('対応する動画接続が未設定です');
  const resolved = await resolveStartImage(project, shot.startImage, loadCapture);
  const snapshot = project.snapshots.find(s => s.id === shot.snapshotId);
  const manifest = { version: 1, scope: { type: 'videoShot', id: shot.id },
    source: { snapshotId: shot.snapshotId, commit: snapshot.sha, sceneId: shot.sceneId, unitIds: [...shot.unitIds] },
    characterIds: [...shot.characterIds], sourceDependencies: resolved.sourceDependencies,
    providerInputs: [{ role: 'start_frame', ...resolved.artifact, transform: { kind: 'identity' } }],
    prompt: shot.prompt, duration: shot.duration, ratio: shot.ratio, connection: { ...connection },
    base_revision: shot.adopted_revision ?? null };
  return { manifest, input_hash: await hashValue(manifest), image: resolved.image };
}

export async function beginVideoJob(project, shotId, connection, loadCapture) {
  const shot = project.videoShots.find(s => s.id === shotId);
  if (!shot) throw Error('対象ショットがありません');
  const jobs = project.jobs.filter(j => j.scope?.type === 'videoShot' && j.scope.id === shotId);
  if (jobs.some(j => ['running', 'unknown', 'submitted', 'cancel_requested', 'output_pending'].includes(j.status))) throw Error('未確定の動画要求を確認してください');
  if (jobs.filter(j => j.base_revision === shot.adopted_revision).length >= 3) throw Error('同じ動画版の試行上限です');
  const request = await videoManifest(project, shot, connection, loadCapture);
  const job = { id: crypto.randomUUID(), kind: 'video', scope: request.manifest.scope,
    source_revision: shot.snapshotId, base_revision: shot.adopted_revision, manifest: request.manifest,
    input_hash: request.input_hash, status: 'running', attempts: 1, at: new Date().toISOString(),
    active_snapshot: project.active, cost: { kind: 'external', amount: null, currency: null } };
  // Caller must save this project successfully BEFORE any paid submission.
  return { project: { ...project, jobs: [...project.jobs, job] }, job, image: request.image };
}

export async function videoJobIsCurrent(project, job, loadCapture) {
  const shot = project.videoShots.find(s => s.id === job.scope?.id);
  if (!shot || project.active !== job.active_snapshot) return false;
  try { return (await videoManifest(project, shot, job.manifest.connection, loadCapture)).input_hash === job.input_hash; }
  catch { return false; }
}
