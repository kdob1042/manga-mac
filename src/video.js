// Video domain records reuse the existing source, artwork, capture and jobs.
// No network requests, second asset registry or embedded video bytes here.
import { sourceUnits } from './core.js';
import { digest, imageHash } from './revisions.js';
import { videoModelForConnection } from './media.js';

const hashPattern = /^[0-9a-f]{64}$/;
const hashValue = value => digest(new TextEncoder().encode(JSON.stringify(value)));
export function videoFrameDimensions(image) {
  if (!image.startsWith('data:image/png;base64,')) throw Error('動画入力はPNGの作画画像に対応しています');
  const bytes = Uint8Array.from(atob(image.split(',')[1].slice(0, 44)), c => c.charCodeAt(0));
  if (bytes.length < 24 || bytes.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10' || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw Error('PNGの画像寸法を確認できません');
  const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > 8192 || height > 8192 || width / height < .5 || width / height > 2) throw Error('画像の寸法が動画入力の上限に適合しません');
  return { width, height, format: 'png' };
}
export function validateVideoFrame(image, ratio) {
  const { width, height } = videoFrameDimensions(image);
  const [w, h] = ratio.split(':').map(Number);
  if (!width || !height || width * h !== height * w) throw Error('開始画像と出力の縦横比を合わせてください。自動切り抜きは行いません');
  return { width, height };
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw Error('未対応の動画入力です');
}

function validateTransition(project, shot) {
  const transition = shot.transition;
  exactKeys(transition, ['pageId', 'fromPanelId', 'toPanelId', 'fromIndex', 'toIndex', 'fromSceneId', 'fromUnitIds', 'fromCharacterIds', 'toSceneId', 'toUnitIds', 'toCharacterIds', 'fromArtworkRevisionId', 'fromArtworkHash', 'toArtworkRevisionId', 'toArtworkHash']);
  if (typeof transition.pageId !== 'string' || typeof transition.fromPanelId !== 'string' || typeof transition.toPanelId !== 'string' || transition.fromPanelId === transition.toPanelId || !Number.isSafeInteger(transition.fromIndex) || !Number.isSafeInteger(transition.toIndex) || transition.fromIndex < 0 || transition.toIndex !== transition.fromIndex + 1) throw Error('隣接コマの読書順が不正です');
  const page = project.layout?.pages?.find(p => p.id === transition.pageId);
  const pagePanelIds = page?.slots?.filter(slot => slot.panelId !== null).map(slot => slot.panelId) ?? [];
  if (!page || pagePanelIds[transition.fromIndex] !== transition.fromPanelId || pagePanelIds[transition.toIndex] !== transition.toPanelId) throw Error('隣接コマは同じページの安定した読書順から選択してください');
  const snapshot = project.snapshots.find(s => s.id === shot.snapshotId);
  const from = project.panels.find(p => p.id === transition.fromPanelId);
  const to = project.panels.find(p => p.id === transition.toPanelId);
  if (!snapshot || !from || !to || from.snapshotId !== shot.snapshotId || to.snapshotId !== shot.snapshotId) throw Error('隣接コマの原作版が一致しません');
  const source = (sceneId, unitIds) => {
    const scene = snapshot.scenes.find(s => s.id === sceneId);
    const units = scene ? sourceUnits(scene.id, scene.text).map(u => u.id) : [];
    if (!scene || !Array.isArray(unitIds) || !unitIds.length || new Set(unitIds).size !== unitIds.length || JSON.stringify(units.filter(id => unitIds.includes(id))) !== JSON.stringify(unitIds)) throw Error('隣接コマの原文範囲・順序が不正です');
  };
  source(transition.fromSceneId, transition.fromUnitIds);
  source(transition.toSceneId, transition.toUnitIds);
  if (from.sceneId !== transition.fromSceneId || JSON.stringify(from.unitIds) !== JSON.stringify(transition.fromUnitIds) || JSON.stringify(from.characterIds) !== JSON.stringify(transition.fromCharacterIds) || to.sceneId !== transition.toSceneId || JSON.stringify(to.unitIds) !== JSON.stringify(transition.toUnitIds) || JSON.stringify(to.characterIds) !== JSON.stringify(transition.toCharacterIds)) throw Error('隣接コマの原稿・人物参照が変わっています');
  if (shot.sceneId !== transition.fromSceneId || JSON.stringify(shot.unitIds) !== JSON.stringify(transition.fromUnitIds)) throw Error('動画の始端原稿範囲が不正です');
  const characterIds = [...new Set([...transition.fromCharacterIds, ...transition.toCharacterIds])];
  if (JSON.stringify(shot.characterIds) !== JSON.stringify(characterIds)) throw Error('動画の人物参照が不正です');
  const adopted = (panel, id, hash, label) => {
    const artwork = project.artworks.find(a => a.id === id && a.hash === hash);
    if (!artwork || panel.artwork_revision !== id || panel.image !== artwork.panel?.image) throw Error(label + 'の採用作画版が一致しません');
    return artwork;
  };
  const fromArtwork = adopted(from, transition.fromArtworkRevisionId, transition.fromArtworkHash, '始端コマ');
  const toArtwork = adopted(to, transition.toArtworkRevisionId, transition.toArtworkHash, '終端コマ');
  if (shot.startImage.kind !== 'artwork' || shot.startImage.id !== fromArtwork.id || shot.startImage.hash !== fromArtwork.hash || shot.endImage.kind !== 'artwork' || shot.endImage.id !== toArtwork.id || shot.endImage.hash !== toArtwork.hash) throw Error('A/Bの採用作画版を動画入力に固定してください');
  const fromSize = validateVideoFrame(fromArtwork.panel.image, shot.ratio);
  const toSize = validateVideoFrame(toArtwork.panel.image, shot.ratio);
  if (fromSize.width !== toSize.width || fromSize.height !== toSize.height) throw Error('始端・終端画像の寸法が一致しません。保存済み変換を用意してから実行してください');
  return transition;
}

export function validateVideoShot(project, shot) {
  exactKeys(shot, ['id', 'snapshotId', 'sceneId', 'unitIds', 'characterIds', 'startImage', 'endImage', 'transition', 'prompt', 'duration', 'ratio', 'adopted_revision']);
  const snapshot = project.snapshots.find(s => s.id === shot.snapshotId);
  const scene = snapshot?.scenes.find(s => s.id === shot.sceneId);
  if (!scene || typeof shot.id !== 'string' || !shot.id) throw Error('動画の原作参照がありません');
  const units = sourceUnits(scene.id, scene.text).map(u => u.id);
  if (!Array.isArray(shot.unitIds) || !shot.unitIds.length || new Set(shot.unitIds).size !== shot.unitIds.length || JSON.stringify(units.filter(id => shot.unitIds.includes(id))) !== JSON.stringify(shot.unitIds)) throw Error('原文の範囲・順序が不正です');
  if (!Array.isArray(shot.characterIds) || new Set(shot.characterIds).size !== shot.characterIds.length || shot.characterIds.some(id => !project.characters.some(c => c.id === id))) throw Error('動画の人物参照が不正です');
  if (typeof shot.prompt !== 'string' || !shot.prompt.trim() || shot.prompt.length > 1000 || !Number.isSafeInteger(shot.duration) || shot.duration <= 0 || typeof shot.ratio !== 'string' || !/^\d+:\d+$/.test(shot.ratio)) throw Error('動画の指示・尺・寸法が未対応です');
  exactKeys(shot.startImage, ['kind', 'id', 'hash']);
  if (!['artwork', 'capture'].includes(shot.startImage.kind) || typeof shot.startImage.id !== 'string' || !hashPattern.test(shot.startImage.hash)) throw Error('開始画像の不変参照が必要です');
  const hasTransition = shot.transition !== undefined || shot.endImage !== undefined;
  if (hasTransition) {
    if (!shot.transition || !shot.endImage) throw Error('A→B動画には始端・終端コマと採用作画版が必要です');
    exactKeys(shot.endImage, ['kind', 'id', 'hash']);
    if (shot.endImage.kind !== 'artwork' || typeof shot.endImage.id !== 'string' || !hashPattern.test(shot.endImage.hash)) throw Error('終端画像は採用作画版に限ります');
    validateTransition(project, shot);
  }
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

export function videoConnectionSupportsEndFrame(connection) {
  return !!videoModelForConnection(connection)?.capabilities?.end_frame;
}

export async function videoManifest(project, shot, connection, loadCapture) {
  validateVideoShot(project, shot);
  exactKeys(connection, ['id', 'provider', 'model', 'adapter_id']);
  const selected = videoModelForConnection(connection);
  if (typeof connection.id !== 'string' || !connection.id || !selected) throw Error('対応する動画接続が未設定です');
  const input = selected.input;
  const durations = Array.isArray(input.durations_sec) ? input.durations_sec : [input.duration_sec];
  if (!durations.includes(shot.duration) || !input.ratios.includes(shot.ratio)) throw Error('選択した動画モデルが尺・寸法に対応していません');
  if (shot.transition && !selected.capabilities.end_frame) throw Error('選択した動画接続・モデルは終端画像に対応していません。有料送信は行いません');
  const start = await resolveStartImage(project, shot.startImage, loadCapture);
  const startDimensions = validateVideoFrame(start.image, shot.ratio);
  const end = shot.transition ? await resolveStartImage(project, shot.endImage, loadCapture) : null;
  const endDimensions = end ? validateVideoFrame(end.image, shot.ratio) : null;
  const snapshot = project.snapshots.find(s => s.id === shot.snapshotId);
  const source = { snapshotId: shot.snapshotId, commit: snapshot.sha, sceneId: shot.sceneId, unitIds: [...shot.unitIds] };
  const manifest = { version: 1, scope: { type: 'videoShot', id: shot.id },
    source, characterIds: [...shot.characterIds],
    sourceDependencies: end ? { from: start.sourceDependencies, to: end.sourceDependencies } : start.sourceDependencies,
    providerInputs: [{ role: 'start_frame', ...start.artifact, width: startDimensions.width, height: startDimensions.height, transform: { kind: 'identity' } }, ...(end ? [{ role: 'end_frame', ...end.artifact, width: endDimensions.width, height: endDimensions.height, transform: { kind: 'identity' } }] : [])],
    prompt: shot.prompt, duration: shot.duration, ratio: shot.ratio, connection: { ...connection },
    base_revision: shot.adopted_revision ?? null };
  if (shot.transition) {
    const t = shot.transition;
    manifest.transition = { pageId: t.pageId, fromPanelId: t.fromPanelId, toPanelId: t.toPanelId,
      fromIndex: t.fromIndex, toIndex: t.toIndex,
      fromArtworkRevisionId: t.fromArtworkRevisionId, fromArtworkHash: t.fromArtworkHash,
      toArtworkRevisionId: t.toArtworkRevisionId, toArtworkHash: t.toArtworkHash };
    source.pageId = t.pageId;
    source.readingOrder = { fromIndex: t.fromIndex, toIndex: t.toIndex };
    source.from = { panelId: t.fromPanelId, sceneId: t.fromSceneId, unitIds: [...t.fromUnitIds], characterIds: [...t.fromCharacterIds] };
    source.to = { panelId: t.toPanelId, sceneId: t.toSceneId, unitIds: [...t.toUnitIds], characterIds: [...t.toCharacterIds] };
  }
  return { manifest, input_hash: await hashValue(manifest), image: start.image, endImage: end?.image ?? null };
}

export async function beginVideoJob(project, shotId, connection, loadCapture) {
  const shot = project.videoShots.find(s => s.id === shotId);
  if (!shot) throw Error('対象ショットがありません');
  const jobs = project.jobs.filter(j => j.scope?.type === 'videoShot' && j.scope.id === shotId);
  if (jobs.some(j => ['running', 'unknown', 'submitted', 'cancel_requested', 'output_pending'].includes(j.status))) throw Error('未確定の動画要求を確認してください');
  if (jobs.filter(j => j.base_revision === shot.adopted_revision).length >= 3) throw Error('同じ動画版の試行上限です');
  const request = await videoManifest(project, shot, connection, loadCapture);
  const selected = videoModelForConnection(connection);
  const job = { id: crypto.randomUUID(), kind: 'video', scope: request.manifest.scope,
    source_revision: shot.snapshotId, base_revision: shot.adopted_revision, manifest: request.manifest,
    input_hash: request.input_hash, status: 'running', attempts: 1, at: new Date().toISOString(),
    active_snapshot: project.active, cost: { kind: selected.locality === 'local' ? 'local' : 'external', amount: null, currency: null } };
  // Caller must save this project successfully BEFORE any paid submission.
  return { project: { ...project, jobs: [...project.jobs, job] }, job, image: request.image, endImage: request.endImage };
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
