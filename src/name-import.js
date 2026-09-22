import { validateLayout, layoutWarnings } from './layout.js';
import { tokenizeSnapshot, sourceResolver, covers } from './source-refs.js';

export const NAME_PLAN_FORMAT = 'manga-mac/name-plan/v1';
export const MAX_NAME_PLAN_BYTES = 2 * 1024 * 1024;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(value);
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error(`${label}に未対応の項目があります`);
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed()) throw Error(`${label}が不正です`);
  return value;
}
async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function parseNamePlan(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_NAME_PLAN_BYTES) throw Error('ネームJSONは2MB以内で指定してください');
  let plan;
  try { plan = JSON.parse(raw); } catch { throw Error('ネームJSONを読み取れません'); }
  if (plan?.format !== NAME_PLAN_FORMAT) throw Error('対応するネームJSONではありません');
  return plan;
}
// Only imports a storyboard. It cannot load media, replace source text, or run jobs.
export async function importNamePlan(project, raw) {
  const plan = parseNamePlan(raw);
  fields(plan, ['format', 'title', 'stage', 'readingDirection', 'source', 'panels', 'layout', 'direction'], 'ネーム');
  text(plan.title, 300, 'タイトル');
  if (plan.stage !== 'name-only' || plan.readingDirection !== 'rtl') throw Error('作画前・右から左読みのネームを指定してください');
  if (project.panels?.length) throw Error('既存コマは上書きしません。コマのない原稿へ取り込んでください');
  if ((project.jobs ?? []).some(job => ['running', 'unknown'].includes(job.status))) throw Error('実行中・応答未確定の処理を解決してください');
  const snapshot = project.snapshots?.find(s => s.id === project.active), source = plan.source;
  fields(source, ['repo', 'workId', 'episodeId', 'branch', 'commit', 'manifestPath', 'scenes'], '原稿来歴');
  if (!snapshot || !source.repo || !id(source.workId) || !id(source.episodeId) || snapshot.repo !== source.repo || (snapshot.workId ?? project.workId) !== source.workId) throw Error('先に同じ作品の原稿を取り込んでください');
  if (!['main', 'dev'].includes(source.branch) || !/^[0-9a-f]{40}$/.test(source.commit ?? '')) throw Error('原稿来歴のブランチ・commitが不正です');
  if (!Array.isArray(source.scenes) || !source.scenes.length || source.scenes.length > 1000) throw Error('原稿場面が不正です');
  const sceneIds = source.scenes.map(s => s?.id);
  if (sceneIds.some(s => !id(s)) || new Set(sceneIds).size !== sceneIds.length || !same(snapshot.scenes.filter(s => sceneIds.includes(s.id)).map(s => s.id), sceneIds)) throw Error('場面の欠落・重複・順序変更があります');
  for (const declared of source.scenes) {
    fields(declared, ['id', 'path', 'sha256', 'unitCount'], '原稿場面');
    const scene = snapshot.scenes.find(s => s.id === declared.id);
    if (scene.episodeId && scene.episodeId !== source.episodeId) throw Error('話の範囲が異なります');
    sourceResolver([{ ...snapshot, scenes: [scene] }]);
    if (!/^[0-9a-f]{64}$/.test(declared.sha256 ?? '') || await hash(scene.text) !== declared.sha256) throw Error(`${declared.id}の原稿が変更されています。ネームを作り直してください`);
  }
  const expected = tokenizeSnapshot({ ...snapshot, scenes: snapshot.scenes.filter(s => sceneIds.includes(s.id)) }).map(u => u.source);
  const resolve = sourceResolver([snapshot]), characters = new Set((project.characters ?? []).map(c => c.id));
  if (!Array.isArray(plan.panels) || !plan.panels.length || plan.panels.length > 2000) throw Error('コマ数が不正です');
  const panelIds = new Set();
  const panels = plan.panels.map(panel => {
    fields(panel, ['id', 'sceneId', 'sourceRefs', 'characterIds', 'prompt', 'intent'], 'コマ');
    if (!id(panel.id) || panelIds.has(panel.id) || !sceneIds.includes(panel.sceneId)) throw Error('コマID・場面が不正です');
    panelIds.add(panel.id);
    text(panel.prompt, 20000, '作画指示');
    if (panel.intent !== undefined) text(panel.intent, 1000, '演出意図');
    if (!Array.isArray(panel.characterIds) || new Set(panel.characterIds).size !== panel.characterIds.length || panel.characterIds.some(c => !characters.has(c))) throw Error('未登録・重複する人物があります');
    if (!Array.isArray(panel.sourceRefs) || !panel.sourceRefs.length || panel.sourceRefs.length > 1000) throw Error('原稿範囲が不正です');
    const sourceRefs = panel.sourceRefs.map(ref => {
      fields(ref, ['sceneId', 'startCp', 'endCp'], '原稿範囲');
      if (ref.sceneId !== panel.sceneId) throw Error('コマの場面と原稿参照が異なります');
      const bound = { snapshotId: snapshot.id, sceneId: ref.sceneId, startCp: ref.startCp, endCp: ref.endCp };
      resolve(bound); return bound;
    });
    return { id: panel.id, sceneId: panel.sceneId, snapshotId: snapshot.id, sourceRefs, contextRefs: [], unitIds: [], characterIds: [...panel.characterIds], prompt: panel.prompt, nameIntent: panel.intent ?? '', image: null, status: 'planned', instructions: [], attempts: 0 };
  });
  const actual = panels.flatMap(panel => panel.sourceRefs);
  if (!covers(expected, actual, { exact: true })) throw Error('原文参照の欠落・重複・範囲外があります');
  const rank = new Map(sceneIds.map((s, i) => [s, i]));
  for (let i = 1; i < actual.length; i++) {
    const a = actual[i - 1], b = actual[i];
    if (rank.get(a.sceneId) > rank.get(b.sceneId) || (a.sceneId === b.sceneId && a.endCp > b.startCp)) throw Error('原文参照の順序が変更されています');
  }
  fields(plan.layout, ['version', 'pages', 'knownPanelIds'], '配置');
  if (!Array.isArray(plan.layout.pages) || !plan.layout.pages.length) throw Error('ページがありません');
  for (const page of plan.layout.pages) {
    fields(page, ['id', 'slots'], 'ページ');
    if (!Array.isArray(page.slots)) throw Error('コマ枠が不正です');
    for (const slot of page.slots) fields(slot, ['id', 'panelId', 'points'], 'コマ枠');
  }
  const layout = structuredClone(plan.layout);
  layout.knownPanelIds = panels.map(p => p.id);
  validateLayout(layout, panels);
  const warnings = layoutWarnings(layout, panels);
  if (warnings.length) throw Error(`ネーム配置を修正してください: ${warnings.join(' / ')}`);
  const draftId = crypto.randomUUID();
  return { ...project, panels, layout, layoutHistory: [], layoutRedo: [], editRedo: [],
    // External geometry is adopted, not regenerated by the next draft run.
    jobs: [...(project.jobs ?? []), { id: crypto.randomUUID(), kind: 'draft_layout', status: 'complete', source_revision: snapshot.id, draft_id: draftId, origin: 'name-plan-import' }],
    draftScope: { id: draftId, snapshotId: snapshot.id, sceneIds },
    // Planned panels must not be marked as finished source application units.
    sourceApplication: { version: 1, units: [] },
    namePlan: { format: plan.format, title: plan.title, source: structuredClone(source), direction: structuredClone(plan.direction ?? {}), snapshotId: snapshot.id, draftId, importedAt: new Date().toISOString(), panelIds: panels.map(p => p.id) } };
}
