import { hasEmbeddedSource, namePartKey } from '../contracts/name-plan/source.mjs';

// The selected plan stays in the existing namePlan field. Other plans live only
// in otherNamePlans, so there is exactly one saved state for each adopted part.
export const allNamePlans = project => [project.namePlan, ...(project.otherNamePlans ?? [])].filter(state => state?.format === 'manga-mac/name-plan/v2');
export const nameSourceSnapshot = project => project.snapshots.find(snapshot => snapshot.id === (hasEmbeddedSource(project.namePlan?.file) ? project.namePlan.snapshotId : project.active));
export function selectNamePart(project, id) {
  const states = allNamePlans(project), selected = states.find(state => state.id === id);
  if (!selected) throw Error('選択したネームがありません');
  return { ...project, namePlan: selected, otherNamePlans: states.filter(state => state.id !== id) };
}
export function assertUniqueNameParts(project) {
  const keys = new Set(), panels = new Set();
  for (const state of allNamePlans(project)) {
    const key = namePartKey(state.file) ?? state.id;
    if (keys.has(key)) throw Error('同じ番号のネームが重複しています');
    keys.add(key);
    for (const id of state.panelIds) {
      if (panels.has(id)) throw Error('複数ネームで同じコマを所有しています');
      panels.add(id);
    }
  }
}
