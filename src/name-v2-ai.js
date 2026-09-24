import { buildNamePrompt } from '../contracts/name-plan/policy.mjs';
import { atomize, selectAtoms } from '../contracts/name-plan/source.mjs';
import { NamePlanError, fail, canonical, validateSchema, treeLeaves } from '../contracts/name-plan/schema.mjs';
import { qaSchema, qaPrompt, validateQA } from '../contracts/name-plan/qa.mjs';
import { createNameFile, createNameCandidate, nameReadToken, localNamePlan, patchNameLayout, setNameLock } from './name-v2.js';
// Caller supplies the existing LLM/Job/save/stop boundary. No second provider or queue.
export async function generateNameCandidate({ current, commit, ask, model, selectedAtomIds, sceneIds, instruction = '', cancelled = () => false, notify = () => {} }) {
  const initial = current(), base = await nameReadToken(initial), snapshot = initial.snapshots.find(snapshot => snapshot.id === initial.active);
  if (!snapshot) fail('source', '原稿を先に取り込んでください');
  const all = atomize(snapshot), wanted = selectedAtomIds?.length ? selectedAtomIds : all.filter(atom => !sceneIds?.length || sceneIds.includes(atom.source.sceneId)).map(atom => atom.id);
  const atoms = selectAtoms(all, wanted), selectedSet = new Set(wanted);
  const first = all.findIndex(atom => atom.id === wanted[0]), last = all.findIndex(atom => atom.id === wanted.at(-1));
  const context = all.slice(Math.max(0, first - 12), Math.min(all.length, last + 13)).filter(atom => !selectedSet.has(atom.id)).map(({ id, text, kind }) => ({ id, text, kind, editable: false }));
  const request = buildNamePrompt({ atoms, context, characters: initial.characters, settings: snapshot.settings ?? [], instruction });
  const id = crypto.randomUUID(), job = { id, kind: 'name_plan', status: 'running', base, source_revision: snapshot.id, model: { provider: model.provider, model: model.model }, policyVersion: request.policyVersion, cardIds: request.cardIds, selectedAtomIds: wanted, at: new Date().toISOString(), requestCount: 0 };
  const saveJob = async patch => {
    const latest = current();
    if (latest.workId !== initial.workId) fail('work_changed', '作品が切り替わりました');
    const jobs = latest.jobs.some(job => job.id === id) ? latest.jobs.map(job => job.id === id ? { ...job, ...patch } : job) : [...latest.jobs, { ...job, ...patch }];
    await commit({ ...latest, jobs });
  };
  await saveJob({}); let previous = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (cancelled()) { await saveJob({ status: 'cancelled', notSubmitted: attempt === 0 }); return null; }
    if (base !== await nameReadToken(current())) { await saveJob({ status: 'stale' }); fail('stale', '原稿・配置・参照が変わりました'); }
    const input = attempt ? buildNamePrompt({ atoms, context, characters: initial.characters, settings: snapshot.settings ?? [], instruction, previous: previous.plan, errors: previous.error }) : request;
    await saveJob({ requestCount: attempt + 1 }); notify(attempt ? 'ネームの構造エラーを1回修正中' : '話の流れとページ構成を設計中');
    let raw;
    try { raw = await ask(model, { ...input, purpose: 'plan', cancelled }); }
    catch (error) { await saveJob({ status: cancelled() ? 'cancelled' : 'unknown', failureCode: 'llm_transport' }); throw error; }
    if (cancelled()) { await saveJob({ status: 'cancelled' }); return null; }
    try {
      const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const file = await createNameFile(initial, plan, wanted, { producer: 'configured-llm', model: model.model, editedBy: [] });
      const candidate = await createNameCandidate(initial, file);
      if (base !== await nameReadToken(current())) { await saveJob({ status: 'stale', nameCandidate: candidate }); fail('stale', '処理中に作品が変わりました。候補は採用せず保持しました'); }
      await saveJob({ status: 'candidate', nameCandidate: candidate }); return candidate;
    } catch (error) {
      if (error?.code === 'stale') throw error;
      if (!(error instanceof NamePlanError) && !(error instanceof SyntaxError)) { await saveJob({ status: 'failed', failureCode: 'internal_validation' }); throw error; }
      previous = { plan: typeof raw === 'string' ? raw.slice(0, 160000) : raw, error: { code: error.code ?? 'json', path: error.path ?? '$', message: error.message } };
      if (attempt === 1) { await saveJob({ status: 'failed', failureCode: previous.error.code }); throw error; }
    }
  }
  return null;
}
const editSchema = {
  type: 'object', properties: { kind: { enum: ['layout', 'replan', 'lock'] }, reason: { type: 'string', minLength: 1, maxLength: 2000 }, tree: { type: 'object' }, locked: { type: 'boolean' } },
  required: ['kind', 'reason'], additionalProperties: false,
};
// The full recursive layout schema is the same as the model/file contract.
export async function proposeNameEdit(project, pageId, instruction, ask) {
  const state = project.namePlan;
  if (!state || state.status !== 'adopted') fail('name', '有効な確定ネームがありません');
  const plan = localNamePlan(state.file, state.namespace), page = plan.pages.find(page => page.id === pageId);
  if (!page || !instruction.trim()) fail('scope', '対象ページと編集指示を指定してください');
  const { planSchema } = await import('../contracts/name-plan/schema.mjs');
  const schema = { ...editSchema, properties: { ...editSchema.properties, tree: { $ref: '#/$defs/tree' } }, $defs: planSchema.$defs };
  const currentLayout=project.layout.pages.find(item=>item.id===pageId);
  const prompt = canonical({
    role: 'manga-mac/page-edit-interpreter',
    task: '現在のネームを作り直さず、指定ページだけの局所編集意図を型付きJSONへ変換する。漫画全体の演出、別ページ、原稿本文は変更しない。',
    constraints: [
      '枠の大小・段組み・位置だけならkind=layoutとtreeを返し、leaf IDと読書順を保持する',
      'コマの追加・削除・原稿割当変更が明示された時だけkind=replanを返す。対象はこのページの原稿範囲だけ',
      'ページ固定の変更だけならkind=lockとlockedを返す',
      '台詞・ナレーション本文を創作、要約、削除、並べ替えしない',
      '別ページ、固定領域、画像、動画、3D構図、作画内容を変更しない',
      '座標points、任意コード、コマンド、URLを出力しない',
      '指示にない改善を追加しない',
    ],
    instruction,
    page,
    currentLayout,
    manualGeometry: !!state.geometryOverride,
    panels: plan.panels.filter(panel => treeLeaves(page.tree).includes(panel.id)),
    locks: state.locks,
  });
  const response = await ask(prompt, schema), value = typeof response === 'string' ? JSON.parse(response) : response;
  // Validate action-specific fields without accepting missing tree/boolean values.
  if (!value || !['layout', 'replan', 'lock'].includes(value.kind) || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000 || Object.keys(value).some(key => !['kind', 'reason', 'tree', 'locked'].includes(key))) fail('edit', '編集案の形式が不正です');
  if (value.kind === 'layout') { if (!value.tree) fail('edit', '段組みがありません'); validateSchema(value.tree, planSchema.$defs.tree, '$', planSchema); }
  if (value.kind === 'lock' && typeof value.locked !== 'boolean') fail('edit', '固定状態が不正です');
  return { ...value, pageId, base: await nameReadToken(project), instruction };
}
export async function applyNameEdit(project, proposal) {
  if (proposal.base !== await nameReadToken(project)) fail('stale', '編集案の基準版が変わりました');
  if (proposal.kind === 'layout') return patchNameLayout(project, proposal.pageId, proposal.tree);
  if (proposal.kind === 'lock') return setNameLock(project, proposal.pageId, proposal.locked);
  fail('replan', 'コマ内容の変更は再ネーム候補として生成してください');
}
export function pageAtomSelection(project, pageId) {
  const state = project.namePlan, plan = localNamePlan(state.file, state.namespace), page = plan.pages.find(page => page.id === pageId);
  if (!page) fail('scope', '対象ページがありません');
  const ids = new Set(treeLeaves(page.tree)); return plan.panels.filter(panel => ids.has(panel.id)).flatMap(panel => panel.atomIds);
}
export async function runNameVisualQA({ project, pageIds, images, ask, imageCapable = false, previous = null }) {
  if (!imageCapable || !images?.length) return { visual: 'not_run', reason: '画像入力対応の接続と実ページ画像が必要です', findings: [] };
  if (pageIds.length < 1 || pageIds.length > 3 || images.length !== pageIds.length) fail('qa_scope', '視覚検査は選択ページと前後を含む最大3ページです');
  const base = await nameReadToken(project);
  if (previous?.base === base && samePageIds(previous.pageIds, pageIds)) return previous;
  const plan = localNamePlan(project.namePlan.file, project.namePlan.namespace);
  const raw = await ask({ prompt: qaPrompt(plan, pageIds), schema: qaSchema, images, purpose: 'vision' });
  const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { ...validateQA(result, plan), visual: 'reviewed_by_model', humanAccepted: false, base, pageIds, at: new Date().toISOString() };
}
function samePageIds(a, b) { return canonical(a) === canonical(b); }
