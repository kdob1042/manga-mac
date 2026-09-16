// Media-to-Blender bindings only. No editable scene graph or duplicate asset catalog.
import { imageHash } from './revisions.js';
const hashPattern = /^[0-9a-f]{64}$/;
// Video preparation lives in the existing batch, before a start image is available.
// It is not a manga panel or a second editable Blender scene.
export function videoSources(project) {
  return (project.shot_batches ?? []).filter(b => b.scope_type === 'videoSource' && b.status === 'complete').flatMap(b => b.bindings);
}
function target(project, id, type) {
  if (type === 'panel') return project.panels.find(p => p.id === id);
  if (type === 'videoSource') return videoSources(project).find(p => p.id === id);
  throw Error('未対応の撮影対象です');
}
export function planVideoSource(project, source, base) {
  if (!base?.session_id || !base.state?.dependencies_pinned || !hashPattern.test(base.state.checkpoint?.hash)) throw Error('Blenderで版固定済みの素材を開いてください');
  const snapshot = project.snapshots.find(s => s.id === source.snapshotId);
  if (source.snapshotId !== project.active || !snapshot?.scenes.some(s => s.id === source.sceneId) || !Array.isArray(source.characterIds) || new Set(source.characterIds).size !== source.characterIds.length || source.characterIds.some(id => !project.characters.some(c => c.id === id))) throw Error('動画撮影の原作・人物を確認してください');
  if (project.shot_batches?.some(b => b.scope_type === 'videoSource' && b.status === 'unknown')) throw Error('先に未確定ショットを確認してください');
  const id = crypto.randomUUID();
  return { id: crypto.randomUUID(), scope_type: 'videoSource', status: 'unknown', base_session: base.session_id, base_revision: base.revision,
    checkpoint_hash: base.state.checkpoint.hash, bindings: [{ id, snapshotId: source.snapshotId, source_revision: source.snapshotId, sceneId: source.sceneId, characterIds: [...source.characterIds] }] };
}
export function planShots(project, panelIds, base) {
  if (!base?.session_id || !base.state?.dependencies_pinned || !hashPattern.test(base.state.checkpoint?.hash)) throw Error('Blenderで版固定済みの素材を開いてください');
  if (!panelIds.length || panelIds.length > 4 || new Set(panelIds).size !== panelIds.length) throw Error('1〜4コマを指定してください');
  const panels = panelIds.map(id => project.panels.find(p => p.id === id));
  if (panels.some(p => !p || p.shot_binding)) throw Error('未割当のコマを指定してください');
  if (project.shot_batches?.some(b => b.status === 'unknown' && b.bindings.some(s => panelIds.includes(s.panel_id)))) throw Error('先に未確定ショットを確認してください');
  return { id: crypto.randomUUID(), status: 'unknown', base_session: base.session_id, base_revision: base.revision,
    checkpoint_hash: base.state.checkpoint.hash, bindings: panels.map(p => ({ id: crypto.randomUUID(), panel_id: p.id, source_revision: p.snapshotId })) };
}
export function attachShots(project, batch, sessions) {
  const live = project.shot_batches?.find(b => b.id === batch.id);
  if (!live || live.status !== 'unknown' || JSON.stringify(live) !== JSON.stringify(batch)) throw Error('ショット要求の基準版が一致しません');
  if (sessions.length !== batch.bindings.length || new Set(sessions.map(s => s.session_id)).size !== sessions.length) throw Error('ショット応答が不正です');
  for (const binding of batch.bindings) {
    const panel = batch.scope_type === 'videoSource' ? binding : project.panels.find(p => p.id === binding.panel_id), session = sessions.find(s => s.session_id === binding.id);
    if (!panel || panel.snapshotId !== binding.source_revision || panel.shot_binding || !session || session.state?.checkpoint?.hash !== batch.checkpoint_hash || !session.state?.dependencies_pinned) throw Error('コマまたはショットが更新されています');
  }
  if (batch.scope_type === 'videoSource') {
    return { ...project, shot_batches: project.shot_batches.map(b => b.id === batch.id ? { ...b, status: 'complete', bindings: b.bindings.map(s => ({ ...s,
      shot_binding: { id: s.id, session_id: s.id, source_revision: s.source_revision, origin_hash: batch.checkpoint_hash }, capture_revision: null })) } : b) };
  }
  return { ...project, shot_batches: project.shot_batches.map(b => b.id === batch.id ? { ...b, status: 'complete' } : b),
    panels: project.panels.map(p => { const b = batch.bindings.find(b => b.panel_id === p.id); return b ? { ...p, shot_binding: { id: b.id, session_id: b.id, source_revision: b.source_revision, origin_hash: batch.checkpoint_hash }, capture_revision: null } : p; }) };
}
export function bindCharacter(project, panelId, characterId, objectName, session, type = 'panel') {
  const panel = target(project, panelId, type);
  const state = session?.state;
  if (!panel?.characterIds.includes(characterId) || panel.shot_binding?.session_id !== session?.session_id || !state?.scenes?.some(s => s.name === state.state.scene && s.objects.includes(objectName))) throw Error('対象人物とBlender内のObjectを選んでください');
  const binding = { character_id: characterId, shot_id: panel.shot_binding.id, object_name: objectName,
    asset_ref: { blend_hash: state.checkpoint.hash, scene: state.state.scene, object: objectName } };
  return { ...project, character_bindings: [...(project.character_bindings ?? []).filter(b => b.shot_id !== binding.shot_id || b.character_id !== characterId), binding] };
}
export async function recordCapture(project, panelId, response, type = 'panel') {
  const panel = target(project, panelId, type), state = response?.state;
  if (!panel?.shot_binding || panel.shot_binding.session_id !== response.session_id || !response.request_id || !state?.dependencies_pinned || !hashPattern.test(state.checkpoint?.hash) || !hashPattern.test(state.image?.hash) || await imageHash(response.preview) !== state.image.hash) throw Error('撮影成果物を検証できません');
  const id = `capture:${response.request_id}`;
  const capture = { id, ...(type === 'panel' ? { panel_id: panel.id } : { scope: { type, id: panel.id }, scene_id: panel.sceneId, character_ids: [...panel.characterIds] }), shot_id: panel.shot_binding.id, session_id: response.session_id, request_id: response.request_id,
    source_revision: panel.snapshotId, parent_revision: panel.capture_revision ?? null, checkpoint: state.checkpoint, image: state.image,
    settings: state.state, dependencies_pinned: true, blender_version: state.blender_version, blender_build: state.blender_build,
    character_bindings: (project.character_bindings ?? []).filter(b => b.shot_id === panel.shot_binding.id) };
  const existing = project.captures?.find(c => c.id === id);
  if (existing) {
    if ((type === 'panel' ? existing.panel_id !== panelId : existing.scope?.type !== type || existing.scope?.id !== panelId) || existing.image.hash !== capture.image.hash || existing.checkpoint.hash !== capture.checkpoint.hash) throw Error('撮影版IDが重複しています');
    return project;
  }
  if (type === 'videoSource') return { ...project, captures: [...(project.captures ?? []), capture],
    shot_batches: project.shot_batches.map(b => b.scope_type === type && b.status === 'complete' ? { ...b, bindings: b.bindings.map(s => s.id === panelId ? { ...s, capture_revision: id } : s) } : b) };
  return { ...project, captures: [...(project.captures ?? []), capture],
    history: [...project.history, { panels: project.panels, label: '撮影原本を更新', at: new Date().toISOString() }],
    panels: project.panels.map(p => p.id === panelId ? { ...p, capture_revision: id } : p) };
}
