import { sourceForPanel } from './core.js';
import { beginVideoJob, createVideoShot, videoFrameDimensions, validateVideoFrame, videoManifest } from './video.js';
import { videoModel, videoEstimateCredits, validateVideoModelRequest } from './media.js';

export function panelVideoDefaults(project, panelId, modelId) {
  const selected = videoModel(modelId), panel = project.panels.find(item => item.id === panelId);
  const artwork = adoptedArtwork(project, panel);
  if (!artwork) return { valid: false, reason: '採用済み作画版が必要です' };
  let dimensions;
  try { dimensions = videoFrameDimensions(artwork.panel.image); }
  catch (error) { return { valid: false, reason: error.message }; }
  const ratio = selected.input.ratios.find(value => {
    const [width, height] = value.split(':').map(Number);
    return dimensions.width * height === dimensions.height * width;
  });
  if (!ratio) return { valid: false, reason: '選択モデルはこの作画画像の縦横比に対応していません。画像の無断切り抜きは行いません' };
  const duration = selected.input.default_duration_sec ?? selected.input.durations_sec[0];
  let recipe;
  try { recipe = panelVideoRecipe(project, panelId, ratio); }
  catch (error) { return { valid: false, reason: error.message }; }
  if (!recipe.valid) return recipe;
  try { validateVideoModelRequest(modelId, { ratio, duration, prompt: 'subtle motion', aspect: dimensions.width / dimensions.height }); }
  catch (error) { return { valid: false, reason: error.message }; }
  return { ...recipe, ratio, duration, estimate: selected.locality === 'local' ? null : videoEstimateCredits(modelId, duration, ratio) };
}

function adoptedArtwork(project, panel) {
  return project.artworks?.find(artwork => artwork.id === panel?.artwork_revision
    && artwork.hash
    && artwork.panel?.image === panel.image) ?? null;
}

export function panelVideoRecipe(project, panelId, ratio) {
  const panel = project.panels.find(item => item.id === panelId);
  if (!panel) return { panelId, valid: false, reason: '対象コマがありません' };
  if (panel.snapshotId !== project.active) return { panelId, panel, valid: false, reason: '現在の原作版のコマだけ選択できます' };
  const artwork = adoptedArtwork(project, panel);
  if (!artwork) return { panelId, panel, valid: false, reason: '採用済み作画版が必要です' };
  try { validateVideoFrame(artwork.panel.image, ratio); }
  catch (error) { return { panelId, panel, artwork, valid: false, reason: error.message }; }
  const pending = project.jobs.some(job => job.scope?.type === 'videoShot'
    && project.videoShots.some(shot => shot.id === job.scope.id && shot.sourcePanelId === panelId)
    && ['running', 'unknown', 'submitted', 'cancel_requested', 'output_pending'].includes(job.status));
  if (pending) return { panelId, panel, artwork, valid: false, reason: 'このコマに未確定の動画要求があります' };
  return {
    panelId,
    panel,
    artwork,
    source: sourceForPanel(panel, project.snapshots.find(snapshot => snapshot.id === panel.snapshotId)),
    valid: true,
    reason: '',
  };
}

export function panelVideoRecipes(project, panelIds, ratio) {
  if (!Array.isArray(panelIds) || new Set(panelIds).size !== panelIds.length) throw Error('動画化するコマの選択が不正です');
  return panelIds.map(panelId => panelVideoRecipe(project, panelId, ratio));
}

export function createPanelVideoShots(project, rows, { batchId = crypto.randomUUID(), duration, ratio } = {}) {
  if (!Array.isArray(rows) || !rows.length || new Set(rows.map(row => row.panelId)).size !== rows.length) throw Error('動画化するコマを選択してください');
  let next = project;
  const shotIds = [];
  for (const row of rows) {
    if (row.enabled === false) continue;
    const recipe = panelVideoRecipe(next, row.panelId, row.ratio ?? ratio);
    if (!recipe.valid) throw Error(`${row.panelId}: ${recipe.reason}`);
    if (typeof row.prompt !== 'string' || !row.prompt.trim()) throw Error(`${row.panelId}: 動きの指示を入力してください`);
    const panel = recipe.panel;
    next = createVideoShot(next, {
      snapshotId: panel.snapshotId,
      sceneId: panel.sceneId,
      unitIds: [...panel.unitIds],
      ...(panel.sourceRefs ? { sourceRefs: structuredClone(panel.sourceRefs) } : {}),
      characterIds: [...panel.characterIds],
      startImage: { kind: 'artwork', id: recipe.artwork.id, hash: recipe.artwork.hash },
      prompt: row.prompt.trim(),
      duration: row.duration ?? duration,
      ratio: row.ratio ?? ratio,
      sourcePanelId: panel.id,
      batchId,
    });
    shotIds.push(next.videoShots.at(-1).id);
  }
  if (!shotIds.length) throw Error('実行するコマを1件以上選択してください');
  return { project: next, batchId, shotIds };
}

// The saved recipes and existing jobs are the batch ledger, including after a
// restart. Any attempted shot is excluded: retrying it is a separate action.
export function savedVideoBatches(project) {
  const batches = new Map();
  for (const shot of project.videoShots ?? []) {
    if (!shot.batchId || shot.snapshotId !== project.active) continue;
    if (!batches.has(shot.batchId)) batches.set(shot.batchId, { id: shot.batchId, shots: [] });
    const jobs = project.jobs.filter(job => job.scope?.type === 'videoShot' && job.scope.id === shot.id);
    batches.get(shot.batchId).shots.push({ shot, job: jobs.at(-1) ?? null });
  }
  return [...batches.values()];
}

export async function runVideoBatch({ batchId, connection, getProject, commit, submit, refresh, loadCapture, shouldStop = () => false, onProgress = () => {} }) {
  const initial = getProject();
  const batch = savedVideoBatches(initial).find(item => item.id === batchId);
  const pending = batch?.shots.filter(item => !item.job) ?? [];
  if (!pending.length) throw Error('未送信の動画レシピがありません');
  const frozenConnection = structuredClone(connection);
  // Validate every pending recipe before the first paid request. The native
  // adapter still enforces its durable reservation and budget per request.
  for (const { shot } of pending) await videoManifest(initial, shot, frozenConnection, loadCapture);
  let submitted = 0;
  for (const { shot } of pending) {
    if (shouldStop()) break;
    const current = getProject();
    if (current.active !== initial.active) throw Error('原作版が変わったためバッチを停止しました');
    if (current.jobs.some(job => job.scope?.type === 'videoShot' && job.scope.id === shot.id)) continue;
    if (JSON.stringify(current.videoShots.find(item => item.id === shot.id)) !== JSON.stringify(shot)) throw Error('動画レシピが変わったため、内容と費用を再確認してください');
    const started = await beginVideoJob(current, shot.id, frozenConnection, loadCapture);
    if (shouldStop()) break;
    await commit(started.project);
    try { await submit(started.job); }
    finally { await refresh(); }
    submitted += 1;
    onProgress(submitted, pending.length);
    const result = getProject().jobs.find(job => job.id === started.job.id);
    if (!result || !['submitted', 'output_pending', 'candidate', 'complete'].includes(result.status)) {
      throw Error('直前の動画要求の結果を確認してください。残りは未送信のまま保存されています');
    }
  }
  return { submitted, stopped: shouldStop() };
}
