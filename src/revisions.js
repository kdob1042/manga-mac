// Manga revisions only: Blender remains the owner of 3D state.
export async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function imageHash(image) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!match) throw Error('画像形式が不正です');
  return digest(Uint8Array.from(atob(match[1]), c => c.charCodeAt(0)));
}
export async function migrateProject(input, recover = false) {
  if (!input || ![1, 2].includes(input.version)) throw Error('未対応の作品スキーマです');
  const p = structuredClone(input);
  p.version = 2; p.revision ??= 0; p.artworks ??= []; p.jobs ??= []; p.history ??= [];
  const known = new Map(p.artworks.map(a => [a.id, a]));
  async function normalize(panel) {
    panel.capture_revision ??= null;
    panel.artwork_revision ??= null;
    if (panel.image && !panel.artwork_revision) {
      const hash = await imageHash(panel.image), id = `legacy:${panel.id}:${hash}`;
      panel.artwork_revision = id;
      if (!known.has(id)) {
        const artwork = { id, hash, parent_revision: null, capture_revision: null, panel: structuredClone(panel), origin: 'legacy' };
        known.set(id, artwork); p.artworks.push(artwork);
      }
    }
  }
  for (const h of p.history) for (const panel of h.panels) await normalize(panel);
  for (const panel of p.panels) await normalize(panel);
  if (recover) p.jobs = p.jobs.map(j => j.status === 'running' ? { ...j, status: 'unknown' } : j);
  return p;
}
function inputState(project, panel) {
  return { active: project.active, panel, characters: panel.characterIds.map(id => project.characters.find(c => c.id === id)) };
}
export async function beginJob(project, panel, kind = 'generate') {
  return { id: crypto.randomUUID(), panelId: panel.id, kind, scope: { type: 'panel', id: panel.id }, source_revision: panel.snapshotId,
    base_revision: panel.artwork_revision ?? null, input_hash: await digest(new TextEncoder().encode(JSON.stringify(inputState(project, panel)))),
    status: 'running', attempts: 1, at: new Date().toISOString() };
}
export async function finishJob(project, job, generated, cancelled = false) {
  const currentJob = project.jobs.find(j => j.id === job.id);
  if (!currentJob || currentJob.status !== 'running') throw Error('制作要求は有効ではありません');
  const panel = project.panels.find(p => p.id === job.panelId);
  const hash = await imageHash(generated.image);
  const valid = !cancelled && panel && job.input_hash === await digest(new TextEncoder().encode(JSON.stringify(inputState(project, panel))));
  const id = `artwork:${job.id}`;
  const result = { ...generated, artwork_revision: id, capture_revision: generated.capture_revision ?? null };
  const artwork = { id, hash, parent_revision: job.base_revision, capture_revision: result.capture_revision, job_id: job.id, panel: result };
  return { ...project, artworks: [...project.artworks, artwork],
    panels: valid ? project.panels.map(p => p.id === job.panelId ? result : p) : project.panels,
    history: valid ? [...project.history, { panels: project.panels, label: job.kind, at: new Date().toISOString() }] : project.history,
    jobs: project.jobs.map(j => j.id === job.id ? { ...j, status: valid ? 'complete' : 'candidate', output_revision: id } : j) };
}
