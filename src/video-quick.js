import { createPanelVideoShots, panelVideoDefaults, runVideoBatch } from './video-batch.js';
import { draftPanelVideoMotion } from './video-plan.js';
import { videoConnection, validateVideoModelRequest } from './media.js';
import { videoManifest } from './video.js';

// Prepare every selected panel before a paid request. Re-entry into an
// existing batch uses the persisted recipes and never drafts or posts a shot
// for which a job already exists.
export async function runPanelVideos({ panelIds, batchId, modelId, connectionId, motionConnection, promptOverrides = {},
  getProject, commit, submit, refresh, loadCapture, shouldStop, onProgress, onBatchSaved,
  draftMotion = draftPanelVideoMotion }) {
  const connection = videoConnection(modelId, connectionId);
  let target = batchId;
  if (!target) {
    const initial = getProject();
    if (!Array.isArray(panelIds) || !panelIds.length || new Set(panelIds).size !== panelIds.length) throw Error('動画化するコマを選択してください');
    const rows = [];
    for (const panelId of panelIds) {
      const recipe = panelVideoDefaults(initial, panelId, modelId);
      if (!recipe.valid) throw Error(`${panelId}: ${recipe.reason}`);
      const prompt = promptOverrides[panelId]?.trim() || await draftMotion(initial, recipe.panel, motionConnection);
      validateVideoModelRequest(modelId, { prompt, duration: recipe.duration, ratio: recipe.ratio });
      rows.push({ panelId, prompt, duration: recipe.duration, ratio: recipe.ratio });
    }
    const latest = getProject();
    if (latest.active !== initial.active || panelIds.some(id => {
      const before = initial.panels.find(item => item.id === id), after = latest.panels.find(item => item.id === id);
      const oldArt = initial.artworks.find(item => item.id === before?.artwork_revision), newArt = latest.artworks.find(item => item.id === after?.artwork_revision);
      return JSON.stringify(before) !== JSON.stringify(after) || oldArt?.hash !== newArt?.hash;
    })) throw Error('動きの案を作成中にコマが変わりました。もう一度実行してください');
    const created = createPanelVideoShots(getProject(), rows);
    for (const shotId of created.shotIds) {
      const shot = created.project.videoShots.find(item => item.id === shotId);
      await videoManifest(created.project, shot, connection, loadCapture);
    }
    await commit(created.project);
    target = created.batchId;
    onBatchSaved?.(target);
  }
  return runVideoBatch({ batchId: target, connection, getProject, commit, submit, refresh, loadCapture, shouldStop, onProgress });
}
