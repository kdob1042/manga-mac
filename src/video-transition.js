import { pagePanels } from './layout.js';
import { createVideoShot, videoFrameDimensions } from './video.js';

function adoptedArtwork(project, panel) {
  return project.artworks?.find(artwork =>
    artwork.id === panel?.artwork_revision
      && artwork.hash
      && artwork.panel?.image === panel.image
  ) ?? null;
}

function pairReason(project, page, from, to) {
  if (!from || !to) return '隣接するコマがありません';
  if (from.snapshotId !== to.snapshotId) return '同じ原作版のページだけ選択できます';
  const fromArtwork = adoptedArtwork(project, from), toArtwork = adoptedArtwork(project, to);
  if (!fromArtwork || !toArtwork) return 'A/B両方に採用済み作画版が必要です';
  let fromDimensions, toDimensions;
  try {
    fromDimensions = videoFrameDimensions(fromArtwork.panel.image);
    toDimensions = videoFrameDimensions(toArtwork.panel.image);
  } catch (error) {
    return error.message;
  }
  if (fromDimensions.width !== toDimensions.width || fromDimensions.height !== toDimensions.height) return 'A/Bの寸法が違います。保存済み変換を用意してから選択してください';
  if (!page) return 'ページがありません';
  return '';
}

export function adjacentPanelPairs(project) {
  return (project.layout?.pages ?? []).flatMap((page, pageIndex) => {
    const panels = pagePanels(project, page);
    return panels.slice(0, -1).map((from, index) => {
      const to = panels[index + 1];
      const fromArtwork = adoptedArtwork(project, from);
      const toArtwork = adoptedArtwork(project, to);
      const reason = pairReason(project, page, from, to);
      return {
        id: from.id + '->' + to.id,
        pageId: page.id,
        pageIndex,
        fromIndex: index,
        toIndex: index + 1,
        fromPanelId: from.id,
        toPanelId: to.id,
        fromSceneId: from.sceneId,
        fromUnitIds: [...(from.unitIds ?? [])],
        fromCharacterIds: [...(from.characterIds ?? [])],
        toSceneId: to.sceneId,
        toUnitIds: [...(to.unitIds ?? [])],
        toCharacterIds: [...(to.characterIds ?? [])],
        fromArtworkRevisionId: fromArtwork?.id ?? null,
        fromArtworkHash: fromArtwork?.hash ?? null,
        toArtworkRevisionId: toArtwork?.id ?? null,
        toArtworkHash: toArtwork?.hash ?? null,
        fromImage: fromArtwork?.panel?.image ?? from.image ?? null,
        toImage: toArtwork?.panel?.image ?? to.image ?? null,
        fromDimensions: fromArtwork ? (() => { try { return videoFrameDimensions(fromArtwork.panel.image); } catch { return null; } })() : null,
        toDimensions: toArtwork ? (() => { try { return videoFrameDimensions(toArtwork.panel.image); } catch { return null; } })() : null,
        valid: !reason,
        reason,
      };
    });
  });
}

function optionFor(project, pairId) {
  return adjacentPanelPairs(project).find(pair => pair.id === pairId);
}

export function createAdjacentVideoShot(project, { pairId, prompt, duration = 5, ratio }) {
  const pair = optionFor(project, pairId);
  if (!pair) throw Error('選択した隣接コマがありません');
  if (!pair.valid) throw Error(pair.reason);
  const from = project.panels.find(panel => panel.id === pair.fromPanelId);
  const to = project.panels.find(panel => panel.id === pair.toPanelId);
  const transition = {
    pageId: pair.pageId,
    fromPanelId: pair.fromPanelId,
    toPanelId: pair.toPanelId,
    fromIndex: pair.fromIndex,
    toIndex: pair.toIndex,
    fromSceneId: pair.fromSceneId,
    fromUnitIds: [...pair.fromUnitIds],
    fromCharacterIds: [...pair.fromCharacterIds],
    toSceneId: pair.toSceneId,
    toUnitIds: [...pair.toUnitIds],
    toCharacterIds: [...pair.toCharacterIds],
    fromArtworkRevisionId: pair.fromArtworkRevisionId,
    fromArtworkHash: pair.fromArtworkHash,
    toArtworkRevisionId: pair.toArtworkRevisionId,
    toArtworkHash: pair.toArtworkHash,
  };
  return createVideoShot(project, {
    snapshotId: from.snapshotId,
    sceneId: from.sceneId,
    unitIds: [...from.unitIds],
    characterIds: [...new Set([...(from.characterIds ?? []), ...(to.characterIds ?? [])])],
    startImage: { kind: 'artwork', id: pair.fromArtworkRevisionId, hash: pair.fromArtworkHash },
    endImage: { kind: 'artwork', id: pair.toArtworkRevisionId, hash: pair.toArtworkHash },
    transition,
    prompt,
    duration,
    ratio,
  });
}

export function createSelectedAdjacentVideoShots(project, pairIds, options = {}) {
  if (pairIds == null) return project;
  if (!Array.isArray(pairIds)) throw Error('隣接コマの選択が不正です');
  if (!pairIds.length) return project;
  if (new Set(pairIds).size !== pairIds.length) throw Error('隣接コマの選択が重複しています');
  let next = project;
  for (const pairId of pairIds) next = createAdjacentVideoShot(next, { ...options, pairId });
  return next;
}
