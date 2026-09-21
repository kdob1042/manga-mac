import { sourceForPanel } from './core.js';
import { createVideoShot, validateVideoFrame } from './video.js';

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
