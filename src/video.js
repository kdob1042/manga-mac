// Video domain records reuse the existing source, artwork, capture and jobs.
// No network requests, second asset registry or embedded video bytes here.
import { sourceUnits } from './core.js';
import { digest, imageHash } from './revisions.js';

const ratios = ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'];
const hashPattern = /^[0-9a-f]{64}$/;
const hashValue = value => digest(new TextEncoder().encode(JSON.stringify(value)));
export function validateVideoFrame(image, ratio) {
  // Initial path reuses PNG artwork/captures without implicit provider cropping.
  if (!image.startsWith('data:image/png;base64,')) throw Error('初期動画入力はPNGの作画・撮影画像に対応しています');
  const bytes = Uint8Array.from(atob(image.split(',')[1].slice(0, 44)), c => c.charCodeAt(0));
  if (bytes.length < 24 || bytes.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10' || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw Error('PNGの画像寸法を確認できません');
  const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20);
  const [w, h] = ratio.split(':').map(Number);
  if (!width || !height || width > 8192 || height > 8192 || width / height < .5 || width / height > 2 || width * h !== height * w) throw Error('開始画像と出力の縦横比を合わせてください。自動切り抜きは行いません');
  return { width, height };
}
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
  // Runway limits the entire encoded Data URI, including base64 overhead.
  const size = atob(image.split(',')[1]).length;
  if (image.length > 5_000_000) throw Error('開始画像は送信用のbase64変換後に5MB以下にしてください');
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
  validateVideoFrame(resolved.image, shot.ratio);
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

export function validateVideoArtifact(artifact) {
  exactKeys(artifact, ['artifact_id', 'hash', 'mime', 'size']);
  if (!hashPattern.test(artifact.hash) || artifact.artifact_id !== artifact.hash || artifact.mime !== 'video/mp4' || !Number.isSafeInteger(artifact.size) || artifact.size < 32 || artifact.size > 128 * 1024 * 1024) throw Error('動画成果物が不正です');
  return artifact;
}

// Collection never changes the accepted pointer, even for the first result.
export function collectVideoResult(project, jobId, artifact) {
  validateVideoArtifact(artifact);
  const job = project.jobs.find(j => j.id === jobId);
  if (!job || job.scope?.type !== 'videoShot' || !['running', 'submitted', 'unknown', 'cancel_requested', 'output_pending'].includes(job.status)) throw Error('結果を接続できる動画要求がありません');
  const id = `video:${job.id}`;
  if (project.videoRevisions.some(v => v.id === id)) throw Error('動画成果物は接続済みです');
  const revision = { id, shot_id: job.scope.id, job_id: job.id, parent_revision: job.base_revision,
    artifact: structuredClone(artifact), input_hash: job.input_hash, created_at: new Date().toISOString() };
  return { ...project, videoRevisions: [...project.videoRevisions, revision],
    jobs: project.jobs.map(j => j.id === jobId ? { ...j, output_revision: id, status: 'candidate' } : j) };
}

export async function adoptVideoCandidate(project, jobId, verifyArtifact, loadCapture) {
  const job = project.jobs.find(j => j.id === jobId), revision = project.videoRevisions.find(v => v.id === job?.output_revision);
  if (!job || job.status !== 'candidate' || !revision || revision.shot_id !== job.scope?.id || revision.input_hash !== job.input_hash || !(await videoJobIsCurrent(project, job, loadCapture))) throw Error('基準版が変わった動画候補は採用できません');
  validateVideoArtifact(revision.artifact);
  // Native hash verification is required at the point of adoption, not only download.
  if (typeof verifyArtifact !== 'function') throw Error('動画ファイルの検証が必要です');
  await verifyArtifact(revision.artifact);
  const shot = project.videoShots.find(s => s.id === revision.shot_id);
  return { ...project, videoShots: project.videoShots.map(s => s.id === shot.id ? { ...s, adopted_revision: revision.id } : s),
    videoHistory: [...project.videoHistory, { shot_id: shot.id, previous_revision: shot.adopted_revision, next_revision: revision.id }],
    jobs: project.jobs.map(j => j.id === jobId ? { ...j, status: 'complete' } : j) };
}

export async function undoVideo(project, shotId, verifyArtifact) {
  const index = project.videoHistory.findLastIndex(h => h.shot_id === shotId);
  const entry = project.videoHistory[index], shot = project.videoShots.find(s => s.id === shotId);
  if (!entry || !shot || shot.adopted_revision !== entry.next_revision) throw Error('元に戻せる動画版がありません');
  if (entry.previous_revision) {
    const old = project.videoRevisions.find(v => v.id === entry.previous_revision && v.shot_id === shotId);
    if (!old || typeof verifyArtifact !== 'function') throw Error('以前の動画版を確認できません');
    validateVideoArtifact(old.artifact); await verifyArtifact(old.artifact);
  }
  return { ...project, videoShots: project.videoShots.map(s => s.id === shotId ? { ...s, adopted_revision: entry.previous_revision } : s),
    videoHistory: project.videoHistory.filter((_, i) => i !== index) };
}
