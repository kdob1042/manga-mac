// Pure domain logic. Source text is never produced by a language model.
export function orderedScenes(manifest, episodeId) {
  if (!Array.isArray(manifest.episodes) || !Array.isArray(manifest.scenes)) throw Error('manifest の形式が不正です');
  const scenes = new Map(manifest.scenes.map(s => [s.id, s]));
  if (scenes.size !== manifest.scenes.length) throw Error('場面IDが重複しています');
  const ids = manifest.episodes.filter(e => !episodeId || e.id === episodeId).flatMap(e => e.scene_ids);
  if (!ids.length || new Set(ids).size !== ids.length) throw Error('読書順が空、または重複しています');
  return ids.map(id => { const s = scenes.get(id); if (!s) throw Error(`場面がありません: ${id}`); safePath(s.path); return s; });
}
export function safePath(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some(p => !p || p === '..' || p === '.') || /[\\?#%]/.test(path)) throw Error('安全でないファイルパス');
  return path;
}
export function sourceUnits(sceneId, text) {
  // Preserve each non-heading paragraph exactly, including dialogue and whitespace.
  return text.split(/\n\s*\n/).flatMap((text, i) => {
    return !text.trim() || /^\s*#/.test(text) ? [] : [{ id: `${sceneId}:u${i}`, text }];
  });
}
export function validatePlan(plan, units, characters) {
  if (!Array.isArray(plan.panels) || !plan.panels.length || plan.panels.length > 120) throw Error('コマ計画が不正です');
  const actual = plan.panels.flatMap(p => p.unitIds ?? []);
  if (JSON.stringify(actual) !== JSON.stringify(units.map(u => u.id))) throw Error('原文の欠落・重複・順序変更を検出しました');
  const allowed = new Set(characters.map(c => c.id));
  for (const p of plan.panels) {
    if (typeof p.prompt !== 'string' || !p.prompt.trim() || !Array.isArray(p.characterIds) || p.characterIds.some(id => !allowed.has(id))) throw Error('人物または作画指示が不正です');
  }
  return plan.panels;
}
export function compositePixels(original, candidate, mask) {
  if (original.length !== candidate.length || original.length !== mask.length * 4) throw Error('画像サイズが一致しません');
  const out = new Uint8ClampedArray(original);
  for (let i = 0; i < mask.length; i++) if (mask[i]) for (let c = 0; c < 4; c++) out[i * 4 + c] = candidate[i * 4 + c];
  return out;
}
export function affectedScenes(previous, next) {
  const settingsChanged = JSON.stringify(previous.settings) !== JSON.stringify(next.settings);
  return next.scenes.filter(s => settingsChanged || !previous.scenes.some(p => p.id === s.id && p.text === s.text && p.design === s.design)).map(s => s.id);
}
export function sourceForPanel(panel, snapshot) {
  const scene = snapshot.scenes.find(s => s.id === panel.sceneId);
  if (!scene) throw Error('原作スナップショットがありません');
  const units = sourceUnits(scene.id, scene.text);
  return panel.unitIds.map(id => { const unit = units.find(u => u.id === id); if (!unit) throw Error('原文の参照がありません'); return unit.text; }).join('\n\n');
}
export function revise(project, panels, label) {
  return { ...project, panels, history: [...project.history, { panels: project.panels, label, at: new Date().toISOString() }] };
}
export const emptyProject = () => ({ version: 1, title: '新しい作品', snapshots: [], active: null, panels: [], characters: [], history: [], jobs: [] });
