// Resolution-independent placement shared by interpolation and regeneration jobs.
export function placementKey(project,id) {
  return JSON.stringify({active:project.active,slots:project.layout.pages.flatMap(p=>p.slots.filter(s=>s.panelId===id)),crop:project.layout.imageCrops?.[id]??null});
}
