// Read-only provenance queries; never infer asset identity from a filename.
export function captureUsers(project, captureIds) {
  const ids = new Set(captureIds), rows = [];
  const artworkUses = id => ids.has(project.artworks?.find(a => a.id === id)?.capture_revision);
  for (const panel of project.panels) {
    if (ids.has(panel.capture_revision) || artworkUses(panel.artwork_revision)) rows.push({ type: 'panel', id: panel.id, sceneId: panel.sceneId });
  }
  for (const shot of project.videoShots ?? []) {
    const adopted = project.videoRevisions?.find(v => v.id === shot.adopted_revision);
    const adoptedJob = project.jobs?.find(j => j.id === adopted?.job_id);
    if ((shot.startImage.kind === 'capture' && ids.has(shot.startImage.id)) || (shot.startImage.kind === 'artwork' && artworkUses(shot.startImage.id)) || ids.has(adoptedJob?.manifest?.sourceDependencies?.capture_revision)) rows.push({ type: 'videoShot', id: shot.id, sceneId: shot.sceneId });
  }
  return rows;
}
export function previousCaptureUsers(project, captureId) {
  const ids = [], seen = new Set([captureId]);
  let capture = project.captures?.find(c => c.id === captureId);
  while (capture?.parent_revision && !seen.has(capture.parent_revision)) {
    seen.add(capture.parent_revision); ids.push(capture.parent_revision);
    capture = project.captures.find(c => c.id === capture.parent_revision);
  }
  return captureUsers(project, ids);
}
export function changedBaseUsers(project, session) {
  const hash = session?.state?.checkpoint?.hash;
  if (!hash || !session.state.dependencies_pinned) return [];
  const rows = new Map();
  for (const batch of project.shot_batches ?? []) {
    if (batch.status !== 'complete' || batch.base_session !== session.session_id || batch.checkpoint_hash === hash) continue;
    for (const binding of batch.bindings) {
      const type = batch.scope_type === 'videoSource' ? 'videoSource' : 'panel';
      const id = type === 'panel' ? binding.panel_id : binding.id;
      const target = type === 'panel' ? project.panels.find(p => p.id === id) : binding;
      if (!target?.shot_binding || target.shot_binding.id !== binding.id) continue;
      rows.set(`${type}:${id}`, { type, id, sceneId: target.sceneId });
      const captures = (project.captures ?? []).filter(c => c.shot_id === binding.id).map(c => c.id);
      for (const row of captureUsers(project, captures)) rows.set(`${row.type}:${row.id}`, row);
    }
  }
  return [...rows.values()];
}
export const usageLabel = row => `${({ panel: '漫画コマ', videoShot: '動画', videoSource: '動画用撮影' })[row.type]} ${row.sceneId ?? ''} / ${row.id}`;
