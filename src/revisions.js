import { ensureLayout } from './layout.js';
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
  if (!input || ![1, 2, 3, 4].includes(input.version)) throw Error('未対応の作品スキーマです');
  const p = structuredClone(input);
  p.version = 4; p.revision ??= 0; p.artworks ??= []; p.jobs ??= []; p.history ??= [];
  p.videoShots ??= []; p.videoRevisions ??= []; p.videoHistory ??= [];
  if (![p.videoShots, p.videoRevisions, p.videoHistory].every(Array.isArray)) throw Error('動画の保存データが不正です');
  p.localizations ??= []; p.output_locale ??= 'ja';
  if (!['ja', 'en'].includes(p.output_locale) || !Array.isArray(p.localizations)) throw Error('作品の言語版が不正です');
  for (const localization of p.localizations) {
    if (localization.locale !== 'en' || typeof localization.snapshot_id !== 'string' || !Array.isArray(localization.units)) throw Error('作品の英訳版が不正です');
    const ids = new Set();
    if (localization.units.some(unit => !unit || typeof unit.id !== 'string' || !unit.id || typeof unit.text !== 'string' || !unit.text.trim() || (ids.has(unit.id) || !ids.add(unit.id)))) throw Error('作品の英訳版が不正です');
  }
  const known = new Map(p.artworks.map(a => [a.id, a]));
  const hashes = new Map();
  const hashOf = image => { if (!hashes.has(image)) hashes.set(image, imageHash(image)); return hashes.get(image); };
  async function normalize(panel) {
    panel.capture_revision ??= null;
    panel.artwork_revision ??= null;
    if (panel.image && !panel.artwork_revision) {
      const hash = await hashOf(panel.image), id = `legacy:${panel.id}:${hash}`;
      panel.artwork_revision = id;
      if (!known.has(id)) {
        const artwork = { id, hash, parent_revision: null, capture_revision: null, panel: structuredClone(panel), origin: 'legacy' };
        known.set(id, artwork); p.artworks.push(artwork);
      }
    }
    if (panel.image && panel.artwork_revision) {
      const artwork = known.get(panel.artwork_revision);
      if (!artwork || artwork.hash !== await hashOf(panel.image)) throw Error('採用画像と版のハッシュが一致しません');
    }
  }
  for (const h of p.history) for (const panel of h.panels) await normalize(panel);
  for (const panel of p.panels) await normalize(panel);
  if (recover) p.jobs = p.jobs.map(j => j.status === 'running' ? { ...j, status: 'unknown' } : j);
  return ensureLayout(p);
}
function inputState(project, panel) {
  return { active: project.active, panel, styles: project.style_references ?? [], characters: panel.characterIds.map(id => project.characters.find(c => c.id === id)) };
}
export async function beginJob(project, panel, kind = 'generate') {
  if (project.jobs.filter(j => j.panelId === panel.id && j.base_revision === (panel.artwork_revision ?? null) && j.source_revision === panel.snapshotId && j.kind === kind).length >= 3) throw Error('同じ基準版での試行上限です。既存候補を確認してください');
  if (project.jobs.some(j => j.panelId === panel.id && ['unknown', 'running'].includes(j.status))) throw Error('応答未確定の制作要求があります');
  return { id: crypto.randomUUID(), panelId: panel.id, kind, scope: { type: 'panel', id: panel.id }, source_revision: panel.snapshotId,
    base_revision: panel.artwork_revision ?? null, input_hash: await digest(new TextEncoder().encode(JSON.stringify(inputState(project, panel)))),
    status: 'running', attempts: 1, cost: { kind: 'local', amount: null, currency: null }, started_at: Date.now(), at: new Date().toISOString() };
}
export async function finishJob(project, job, generated, cancelled = false, candidateOnly = false) {
  const currentJob = project.jobs.find(j => j.id === job.id);
  if (!currentJob || currentJob.status !== 'running') throw Error('制作要求は有効ではありません');
  const panel = project.panels.find(p => p.id === job.panelId);
  const hash = await imageHash(generated.image);
  const valid = !cancelled && !candidateOnly && panel && job.input_hash === await digest(new TextEncoder().encode(JSON.stringify(inputState(project, panel))));
  const id = `artwork:${job.id}`;
  const result = { ...generated, artwork_revision: id, capture_revision: generated.capture_revision ?? null };
  const artwork = { id, hash, parent_revision: job.base_revision, capture_revision: result.capture_revision, job_id: job.id, panel: result };
  return { ...project, artworks: [...project.artworks, artwork],
    panels: valid ? project.panels.map(p => p.id === job.panelId ? result : p) : project.panels,
    history: valid ? [...project.history, { panels: project.panels, label: job.kind, at: new Date().toISOString() }] : project.history,
    jobs: project.jobs.map(j => j.id === job.id ? { ...j, status: valid ? 'complete' : 'candidate', output_revision: id, finished_at: Date.now(), duration_ms: Date.now() - (j.started_at ?? Date.now()) } : j) };
}

export async function adoptCandidate(project, jobId) {
  const job = project.jobs.find(j => j.id === jobId), panel = project.panels.find(p => p.id === job?.panelId);
  const artwork = project.artworks.find(a => a.id === job?.output_revision);
  if (!job || job.status !== 'candidate' || !panel || !artwork || job.input_hash !== await digest(new TextEncoder().encode(JSON.stringify(inputState(project, panel)))) || artwork.hash !== await imageHash(artwork.panel.image)) throw Error('基準版が変わった候補は採用できません');
  return { ...project, panels: project.panels.map(p => p.id === panel.id ? structuredClone(artwork.panel) : p),
    history: [...project.history, { panels: project.panels, label: '作画候補を採用', at: new Date().toISOString() }],
    jobs: project.jobs.map(j => j.id === jobId ? { ...j, status: 'complete' } : j) };
}
export function abandonJob(project, jobId) {
  const job = project.jobs.find(j => j.id === jobId);
  if (!job || !['unknown', 'candidate'].includes(job.status)) throw Error('未確定・候補の要求だけを解決できます');
  return { ...project, jobs: project.jobs.map(j => j.id === jobId ? { ...j, status: 'abandoned' } : j) };
}
