import { validateLayout, layoutWarnings } from './layout.js';
import { FORMAT, POLICY_VERSION, parseNameFile, validatePlan, fileSchema, validateSchema, canonical, sha256, fail, treeLeaves } from '../contracts/name-plan/schema.mjs';
import { bindSource, atomize, sourceDescriptor, sourceCharacterIds, intersects, clipRefs, orderedCoverage, resolveRef, sourceParagraphs, requiredTextForSource } from '../contracts/name-plan/source.mjs';
import { compileNameLayout } from '../contracts/name-plan/layout.mjs';
import { diagnosePlan } from '../contracts/name-plan/qa.mjs';
export { FORMAT, requiredTextForSource };
const same = (a, b) => canonical(a) === canonical(b);
const printed = presentation => ['dialogue', 'thought', 'narration'].includes(presentation);
const stripImage = ({ image, ...panel }) => ({ ...panel, imagePresent: !!image });
const charIdentity = project => (project.characters ?? []).map(({ id, name, description, hash }) => ({ id, name: name ?? '', description: description ?? '', hash: hash ?? '' }));
const sourceScope = snapshot => snapshot.workId ? `${snapshot.repo}#${snapshot.workId}` : snapshot.repo;
function sourceCharacterBinding(project, snapshot) {
  const expectedScope = sourceScope(snapshot), allowed = new Set(sourceCharacterIds(snapshot)), result = new Map();
  for (const character of project.characters ?? []) {
    const source = character.source, sourceId = source?.character_id;
    if (!sourceId || !allowed.has(sourceId) || source.repo !== snapshot.repo || (source.scope ?? source.repo) !== expectedScope) continue;
    if (result.has(sourceId) && result.get(sourceId) !== character.id) fail('character', `原稿人物${sourceId}のアプリ内対応が重複しています`);
    result.set(sourceId, character.id);
  }
  return result;
}
function projectCharacterIds(project, snapshot, ids) {
  const bindings = sourceCharacterBinding(project, snapshot);
  return ids.map(id => {
    const local = bindings.get(id);
    if (!local) fail('character', `原稿人物${id}の基準画・アプリ内対応がありません`);
    return local;
  });
}
function portableCharacterPlan(project, snapshot, plan) {
  const allowed = new Set(sourceCharacterIds(snapshot)), byProjectId = new Map((project.characters ?? []).map(character => [character.id, character]));
  const expectedScope = sourceScope(snapshot);
  const sourceIdFor = id => {
    const character = byProjectId.get(id);
    if (character) {
      const source = character.source;
      if (source?.repo === snapshot.repo && (source.scope ?? source.repo) === expectedScope && allowed.has(source.character_id)) return source.character_id;
      if (!allowed.has(id)) fail('character', `人物${id}は原稿側の固定人物IDへ変換できません`);
    }
    if (allowed.has(id)) return id;
    fail('character', `人物${id}は対象原稿にありません`);
  };
  const portable = structuredClone(plan);
  if (!Array.isArray(portable?.panels)) return portable;
  portable.panels = portable.panels.map(panel => ({ ...panel, characterIds: Array.isArray(panel.characterIds) ? panel.characterIds.map(sourceIdFor) : panel.characterIds }));
  return portable;
}
export async function nameReadToken(project) {
  return sha256({ workId: project.workId ?? null, active: project.active, panels: project.panels.map(stripImage), layout: project.layout ?? null, application: project.sourceApplication ?? null, name: project.namePlan?.format===FORMAT?{fileHash:project.namePlan.fileHash,status:project.namePlan.status,locks:project.namePlan.locks,geometryOverride:project.namePlan.geometryOverride}:null, characters: charIdentity(project), settings: project.snapshots.find(s => s.id === project.active)?.settings ?? [] });
}
function shortHash(value) { let a = 2166136261; for (const c of value) { a ^= c.codePointAt(0); a = Math.imul(a, 16777619); } return (a >>> 0).toString(16).padStart(8, '0'); }
export function localNamePlan(file, namespace) {
  const panelIds = Object.fromEntries(file.plan.panels.map(panel => [panel.id, `${namespace}:${panel.id.slice(0, 100)}:${shortHash(panel.id)}`]));
  const pageIds = Object.fromEntries(file.plan.pages.map(page => [page.id, `${namespace}:${page.id.slice(0, 100)}:${shortHash(page.id)}`]));
  const tree = node => node.type === 'leaf' ? { ...node, panelId: panelIds[node.panelId] } : { ...node, children: node.children.map(tree) };
  return { ...structuredClone(file.plan), panels: file.plan.panels.map(panel => ({ ...panel, id: panelIds[panel.id] })), pages: file.plan.pages.map(page => ({ ...page, id: pageIds[page.id], tree: tree(page.tree) })) };
}
function boxesFor(panel, atoms, coverage) {
  const shown = panel.atomIds.map(id => ({ atom: atoms.get(id), entry: coverage.get(id) })).filter(({ entry }) => printed(entry.presentation));
  const total = shown.reduce((sum, item) => sum + Math.max(12, [...item.atom.text].length), 0);
  let y = .03;
  return { mode: 'balloons', boxes: shown.map(({ atom, entry }, i) => {
    const height = .55 * Math.max(12, [...atom.text].length) / Math.max(1, total);
    const box = { id: `box:${panel.id}:${i}`, sourceRefs: [{ ...atom.source }], x: .05, y, width: .9, height: Math.max(.06, height), kind: entry.presentation === 'dialogue' ? 'balloon' : entry.presentation === 'thought' ? 'thought' : 'narration', shape: entry.presentation === 'narration' ? 'rect' : 'round', fontSize: 48, lineHeight: 1.25, padding: 10, tail: null };
    y += height + .015; return box;
  }) };
}
function initialMetrics(plan, atoms, coverage) {
  return Object.fromEntries(plan.panels.map(panel => {
    const lengths = panel.atomIds.filter(id => printed(coverage.get(id).presentation)).map(id => [...atoms.get(id).text].length);
    return [panel.id, lengths.length ? { minWidth: 320, minHeight: Math.max(160, lengths.reduce((sum, n) => sum + Math.ceil(n / 10) * 60 + 20, 0) / .55) } : { minWidth: 128, minHeight: 110 }];
  }));
}
export async function createNameCandidate(project, raw, { textMetrics, profile, namespace } = {}) {
  const file = typeof raw === 'string' ? parseNameFile(raw) : validateSchema(structuredClone(raw), fileSchema);
  const bound = await bindSource(file, project), validated = validatePlan(file.plan, bound.atoms, sourceCharacterIds(bound.snapshot), bound.contextAtoms);
  const fileHash = await sha256(file), ns = namespace ?? `np${fileHash.slice(0, 12)}`;
  if(typeof ns!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,39}$/.test(ns))fail('namespace','ネームの内部識別子が不正です');
  const plan = localNamePlan(file, ns);
  const metrics = textMetrics ?? initialMetrics(plan, validated.atomMap, validated.coverage);
  const compiled = compileNameLayout(plan, profile, metrics);
  const panels = plan.panels.map(panel => {
    const refs = panel.atomIds.map(id => ({ ...validated.atomMap.get(id).source })), contextRefs = panel.contextAtomIds.map(id => ({ ...validated.atomMap.get(id).source }));
    const basis = refs[0] ?? contextRefs[0];
    const requiredText = panel.atomIds.filter(id => printed(validated.coverage.get(id).presentation)).map(id => ({ ...validated.atomMap.get(id).source }));
    const lettering = boxesFor(panel, validated.atomMap, validated.coverage);
    return { id: panel.id, snapshotId: bound.snapshot.id, sceneId: basis.sceneId, sourceRefs: refs, contextRefs, requiredText, unitIds: [], characterIds: projectCharacterIds(project, bound.snapshot, panel.characterIds), prompt: `${panel.prompt}\n構図: ${panel.shotIntent}\n保護する要素: ${panel.protect.join('、')}\n視線: ${panel.gaze}\nNo text, no lettering, no balloons.`, nameIntent: panel.shotIntent, namePlanVersion: 2, image: null, artwork_revision: null, capture_revision: null, status: 'planned', instructions: [], attempts: 0, lettering, letteringStatus: 'draft', letteringArtworkRevision: null };
  });
  const sourcePolicy = bound.atoms.map(atom => {
    const entry = validated.coverage.get(atom.id);
    return { atomId: atom.id, source: { ...atom.source }, kind: atom.kind, presentation: entry.presentation, requiredText: printed(entry.presentation) ? [{ ...atom.source }] : [], reason: entry.reason };
  });
  const previous = { base: await nameReadToken(project), source: bound.descriptor };
  return { version: 2, id: `name-candidate:${fileHash}`, namespace: ns, file, fileHash, previous, panels, layout: compiled.layout, sourcePolicy, compilerVersion: compiled.compilerVersion, profile: compiled.profile, metrics, diagnostics: compiled.diagnostics, qa: diagnosePlan(plan, compiled.layout), status: 'candidate' };
}
function refsCover(targets, actual) {
  for (const target of targets) if (!orderedCoverage([target], clipRefs(actual, target))) return false;
  return true;
}
export function nameCheckpoint(project, label) {
  const keys = ['panels', 'layout', 'sourceApplication', 'draftScope', 'namePlan', 'layoutHistory', 'layoutRedo', 'panelMotions', 'motionHistory', 'characters', 'style_references', 'output_locale'];
  const state = Object.fromEntries(keys.map(key => [key, structuredClone(project[key] ?? (key === 'sourceApplication' ? { version: 1, units: [] } : key === 'output_locale' ? 'ja' : key === 'draftScope' || key === 'namePlan' ? null : []))]));
  return { ...state, id: crypto.randomUUID(), active: project.active, draftCheckpoint: true, label, at: new Date().toISOString() };
}
// Name edits share the normal Undo stack; draft switching retains its own checkpoint.
export const NAME_EDIT_FIELDS = ['panels','layout','sourceApplication','draftScope','namePlan','layoutHistory','layoutRedo','panelMotions','motionHistory'];
export function nameEditState(project) { return Object.fromEntries(NAME_EDIT_FIELDS.map(key => [key, structuredClone(project[key] ?? null)])); }
export function recordNameEdit(previous, next, label) {
  const before=nameEditState(previous), after=nameEditState(next);
  return {...next,history:[...previous.history,{...before,nameEdit:true,edit:true,after,label,at:new Date().toISOString()}],editRedo:[]};
}
export async function editNameCandidateLayout(project,candidate,layout) {
  if(candidate.status!=='candidate'||candidate.previous.base!==await nameReadToken(project))fail('stale','候補の基準版が変わりました');
  validateLayout(layout,candidate.panels);
  const warnings=layoutWarnings(layout,candidate.panels);
  if(warnings.length)fail('candidate_layout',warnings.join(' / '));
  return {...candidate,layout:structuredClone(layout),compiledLayout:structuredClone(candidate.compiledLayout??candidate.layout),manualLayout:true};
}
export async function adoptNameCandidate(project, candidate, mode = 'replace') {
  if (!['replace', 'separate'].includes(mode) || candidate.status !== 'candidate' || candidate.previous.base !== await nameReadToken(project)) fail('stale', '候補の基準版が変わりました。現在の作品から再確認してください');
  await bindSource(candidate.file, project);
  if (project.jobs.some(job => ['running', 'unknown'].includes(job.status) && job.kind !== 'name_plan')) fail('busy', '実行中・応答未確定の制作を先に解決してください');
  const checked = await createNameCandidate(project, candidate.file, { profile: candidate.profile, textMetrics: candidate.metrics, namespace: candidate.namespace });
  if (checked.fileHash!==candidate.fileHash || !same(checked.panels, candidate.panels) || !same(checked.layout, candidate.manualLayout ? candidate.compiledLayout : candidate.layout) || !same(checked.sourcePolicy, candidate.sourcePolicy)) fail('candidate_changed', '候補データが検証後に変更されました');
  validateLayout(candidate.layout,candidate.panels);
  const candidateWarnings=layoutWarnings(candidate.layout,candidate.panels);
  if(candidateWarnings.length)fail('candidate_layout',candidateWarnings.join(' / '));
  const targets = candidate.sourcePolicy.map(entry => entry.source), targetScenes = new Set(targets.map(ref => ref.sceneId));
  const oldPanels = project.panels, oldPages = project.layout?.pages ?? [];
  let start = oldPages.length, end = start, remove = new Set();
  if (mode === 'separate') { start = 0; end = oldPages.length; remove = new Set(oldPanels.map(panel => panel.id)); }
  else {
    for (const panel of oldPanels) {
      if (targetScenes.has(panel.sceneId) && panel.snapshotId !== project.active) fail('source_update', '旧原稿版のコマがあります。原稿差分を確認するか、別初稿として採用してください');
      if ((panel.sourceRefs ?? []).some(ref => targets.some(target => intersects(ref, target)))) {
        if (!refsCover(panel.sourceRefs, targets)) fail('expand_scope', '同じコマに選択外の原稿があります。対象コマの全原稿を選ぶか、別初稿として採用してください', panel.id, { requiredRefs: panel.sourceRefs });
        remove.add(panel.id);
      }
    }
    // Context-only beats anchored in a replaced range belong to that range too.
    for (const panel of oldPanels) if (!(panel.sourceRefs ?? []).length && panel.contextRefs?.some(ref => targets.some(target => intersects(ref, target)))) remove.add(panel.id);
    const indices = oldPages.flatMap((page, i) => page.slots.some(slot => remove.has(slot.panelId)) ? [i] : []);
    if (indices.length) {
      start = Math.min(...indices); end = Math.max(...indices) + 1;
      const extra = oldPages.slice(start, end).flatMap(page => page.slots.map(slot => slot.panelId)).filter(id => id && !remove.has(id));
      if (extra.length) fail('expand_pages', '同じページに対象外のコマがあります。ページ範囲を広げるか、別初稿として採用してください', '$', { panelIds: extra });
      if (oldPages.slice(start, end).some(page => project.namePlan?.locks?.pages?.[page.id]) || [...remove].some(id => project.namePlan?.locks?.panelPoints?.[id])) fail('locked', '固定したページ・コマを含むため差替えできません');
    } else {
      const snapshot = project.snapshots.find(s => s.id === project.active), rank = new Map(snapshot.scenes.map((scene, i) => [scene.id, i]));
      const target = targets[0];
      const firstLater = oldPages.findIndex(page => page.slots.some(slot => { const p = oldPanels.find(p => p.id === slot.panelId), r = p?.sourceRefs?.[0] ?? p?.contextRefs?.[0]; return r && r.snapshotId === project.active && (rank.get(r.sceneId) > rank.get(target.sceneId) || r.sceneId === target.sceneId && r.startCp >= targets.at(-1).endCp); }));
      start = firstLater < 0 ? oldPages.length : firstLater; end = start;
    }
  }
  const retained = oldPanels.filter(panel => !remove.has(panel.id));
  if (candidate.panels.some(panel => retained.some(old => old.id === panel.id))) fail('duplicate', '既存コマとIDが重複します');
  const pages = [...oldPages.slice(0, start), ...structuredClone(candidate.layout.pages), ...oldPages.slice(end)], all = [...retained, ...structuredClone(candidate.panels)];
  const panels = pages.flatMap(page => page.slots.filter(slot => slot.panelId).map(slot => all.find(panel => panel.id === slot.panelId)));
  if (panels.some(panel => !panel) || new Set(panels.map(panel => panel.id)).size !== all.length) fail('placement', '未割当コマがあります。既存配置を解決してから採用してください');
  const oldPolicy = mode === 'separate' ? [] : (project.namePlan?.sourcePolicy ?? []).filter(entry => !targets.some(target => intersects(entry.source, target)));
  const snapshot = project.snapshots.find(s => s.id === project.active), sceneRank = new Map(snapshot.scenes.map((scene, i) => [scene.id, i]));
  const sourcePolicy = [...oldPolicy, ...structuredClone(candidate.sourcePolicy)].sort((a, b) => (a.source.snapshotId === project.active ? 1 : 0) - (b.source.snapshotId === project.active ? 1 : 0) || (sceneRank.get(a.source.sceneId) ?? -1) - (sceneRank.get(b.source.sceneId) ?? -1) || a.source.startCp - b.source.startCp);
  const application = mode === 'separate' ? [] : (project.sourceApplication?.units ?? []).filter(unit => !targets.some(target => intersects(unit.source, target)));
  const history = [...project.history, nameCheckpoint(project, 'ネーム採用前の原稿')];
  const id = `name:${candidate.fileHash}`, scope = { id, snapshotId: project.active, sceneIds: [...targetScenes] };
  return { ...project, panels, layout: { ...project.layout, version: 1, pages, knownPanelIds: panels.map(panel => panel.id) }, sourceApplication: { version: 1, units: application }, history, draftScope: scope,
    layoutHistory: [], layoutRedo: [], editRedo: [],
    namePlan: { format: FORMAT, status: 'adopted', id, namespace: candidate.namespace, file: structuredClone(candidate.file), fileHash: candidate.fileHash, snapshotId: project.active, draftId: id, panelIds: candidate.panels.map(panel => panel.id), pageIds: candidate.layout.pages.map(page => page.id), sourcePolicy, compilerVersion: candidate.compilerVersion, profile: candidate.profile, metrics: candidate.metrics, compiledLayout: structuredClone(checked.layout), geometryOverride: !!candidate.manualLayout, locks: mode === 'separate' ? { pages: {}, panelPoints: {} } : structuredClone(project.namePlan?.locks ?? { pages: {}, panelPoints: {} }), qa: candidate.qa, importedAt: new Date().toISOString() },
    jobs: [...project.jobs.map(job => job.kind === 'name_plan' && job.nameCandidate?.id === candidate.id ? { ...job, status: 'complete' } : job), { id: crypto.randomUUID(), kind: 'draft_layout', status: 'complete', source_revision: project.active, draft_id: id, origin: 'name-plan-v2' }],
  };
}
export function nameLetteringProblems(panel) {
  if (panel?.namePlanVersion !== 2) return [];
  const required = panel.requiredText, boxes = panel.lettering?.boxes;
  const validRef = ref => ref && typeof ref.snapshotId === 'string' && typeof ref.sceneId === 'string'
    && Number.isSafeInteger(ref.startCp) && Number.isSafeInteger(ref.endCp) && ref.startCp >= 0 && ref.endCp > ref.startCp;
  if (!Array.isArray(required) || !required.every(validRef)) return [{code:'lettering',message:'必須台詞の設定が不正です'}];
  const actual = Array.isArray(boxes) ? boxes.flatMap(box => box?.sourceRefs ?? []) : [];
  const problems = [];
  if (!actual.every(validRef) || !orderedCoverage(required, actual)) problems.push({code:'lettering',message:'掲載文字の欠落・重複・順序変更があります'});
  if (required.length && (panel.lettering?.mode !== 'balloons' || panel.letteringStatus !== 'ready'
    || panel.letteringArtworkRevision !== panel.artwork_revision)) problems.push({code:'incomplete',message:'文字配置が未完了、または現在の作画に対応していません。仕上げで文字配置を適用してください'});
  return problems;
}

export function validateV2State(project, { complete = false } = {}) {
  const state = project.namePlan;
  if (state?.format && ![FORMAT,'manga-mac/name-plan/v1'].includes(state.format))fail('unsupported_name','保存ネームの版に対応していません');
  if (state?.format !== FORMAT) return true;
  validateSchema(state.file,fileSchema);
  if(!['adopted','stale'].includes(state.status))fail('saved_name','保存ネームの状態が不正です');
  if (!Array.isArray(state.sourcePolicy) || !Array.isArray(state.panelIds) || !Array.isArray(state.pageIds)) fail('saved_name', '保存したネームの形式が不正です');
  const policies = state.sourcePolicy, atomMaps=new Map();
  policies.forEach((entry, i) => {
    const text = resolveRef(project.snapshots, entry.source);
    const key=JSON.stringify([entry.source.snapshotId,entry.source.sceneId]);
    if(!atomMaps.has(key)){const snapshot=project.snapshots.find(s=>s.id===entry.source.snapshotId);atomMaps.set(key,new Map(atomize(snapshot,[entry.source.sceneId]).map(atom=>[atom.id,atom])));}
    const bound=atomMaps.get(key).get(entry.atomId);
    if(!bound||!same(bound.source,entry.source)||bound.kind!==entry.kind)fail('policy_binding','原稿単位と掲載方針の位置対応が変わっています');
    if(!['dialogue','thought','narration','visual','reference'].includes(entry.presentation))fail('policy','掲載方針の種類が不正です');
    if(printed(entry.presentation)?!same(entry.requiredText,[entry.source]):entry.requiredText?.length!==0)fail('text_policy','掲載文字の方針が一致しません');
    if (!Array.isArray(entry.requiredText) || policies.slice(0, i).some(old => intersects(old.source, entry.source))) fail('policy', '掲載方針が重複しています');
    for (const ref of entry.requiredText) if (!orderedCoverage([ref], clipRefs([entry.source], ref))) fail('text_policy', '掲載文字が原稿範囲外です');
    if (entry.kind === 'dialogue' && !orderedCoverage([entry.source], entry.requiredText)) fail('dialogue', '台詞の掲載範囲が欠落しています');
    if (entry.presentation === 'reference' && entry.requiredText.length) fail('markup', '参照情報を台詞として掲載できません');
    if (text.length === 0) fail('source', '原稿範囲が空です');
  });
  const panels = state.panelIds.map(id => project.panels.find(panel => panel.id === id));
  if (panels.some(panel => !panel)) { if(state.status==='stale'&&!complete)return true; fail('panel', '確定ネームのコマがありません'); }
  const currentPolicy = policies.filter(entry => panels.some(panel => panel.sourceRefs.some(ref => intersects(ref, entry.source))));
  const expected = currentPolicy.map(entry => entry.source), actual = panels.flatMap(panel => panel.sourceRefs);
  if (!orderedCoverage(expected, actual)) fail('source_order', '確定ネームの原稿対応・順序が変わっています');
  const required = currentPolicy.flatMap(entry => entry.requiredText), shown = panels.flatMap(panel => panel.requiredText ?? []);
  if (!orderedCoverage(required, shown)) fail('text_policy', '確定した掲載文字が変わっています');
  for (const panel of panels) {
    const found = (project.layout?.pages ?? []).flatMap(page => page.slots).filter(slot => slot.panelId === panel.id);
    if (found.length !== 1) fail('placement', 'コマの配置が欠落・重複しています');
    if (state.locks?.panelPoints?.[panel.id] && !same(found[0].points, state.locks.panelPoints[panel.id])) fail('locked', '固定したコマを変更できません', panel.id);
    if (complete && !panel.image) fail('incomplete', '選択範囲の作画が未完了です', panel.id);
    if (complete) {
      const problem = nameLetteringProblems(panel)[0];
      if (problem) fail(problem.code, problem.message, panel.id);
    }
  }
  for (const [id, locked] of Object.entries(state.locks?.pages ?? {})) if (!same(project.layout.pages.find(page => page.id === id), locked)) fail('locked', '固定ページを変更できません', id);
  return true;
}
export function refreshNameMetadata(project) {
  if (project.namePlan?.format !== FORMAT) return project;
  const next = { ...project, namePlan: { ...project.namePlan } }, state = next.namePlan;
  const currentPages = project.layout.pages.filter(page => state.pageIds.includes(page.id));
  state.geometryOverride = !same(currentPages, state.compiledLayout.pages);
  if (state.snapshotId !== project.active || state.panelIds.some(id=>!project.panels.some(panel=>panel.id===id))) state.status = 'stale';
  validateV2State(next); return next;
}
export async function patchNameLayout(project, pageId, nextTree) {
  const state = project.namePlan;
  if (state?.format !== FORMAT || state.status !== 'adopted') fail('name', '有効な確定ネームがありません');
  if (state.geometryOverride) fail('manual_override', '手動の自由配置を保持しています。自動配置へ戻す範囲を先に確認してください');
  const file = structuredClone(state.file), plan = localNamePlan(file, state.namespace), index = plan.pages.findIndex(page => page.id === pageId);
  if (index < 0) fail('scope', '対象ページがありません');
  const oldIds = treeLeaves(plan.pages[index].tree);
  const reverse = new Map(plan.panels.map((panel, i) => [panel.id, file.plan.panels[i].id]));
  const convert = node => node.type === 'leaf' ? { ...node, panelId: reverse.get(node.panelId) } : { ...node, children: node.children.map(convert) };
  if (!same(treeLeaves(nextTree), oldIds)) fail('scope', '配置だけの変更ではコマや原稿順を変えられません');
  file.plan.pages[index].tree = convert(nextTree);
  const rebound = await bindSource(file, project); validatePlan(file.plan, rebound.atoms, sourceCharacterIds(rebound.snapshot), rebound.contextAtoms);
  const compiled = compileNameLayout(localNamePlan(file, state.namespace), state.profile, state.metrics, state.locks);
  const nextPages = project.layout.pages.map(page => page.id === pageId ? compiled.layout.pages.find(p => p.id === pageId) : page);
  const next = { ...project, history: [...project.history, nameCheckpoint(project, 'ネーム配置変更前')], layout: { ...project.layout, pages: nextPages }, layoutRedo: [], editRedo: [], namePlan: { ...state, file, fileHash: await sha256(file), compiledLayout: { ...state.compiledLayout, pages: state.compiledLayout.pages.map(page => page.id === pageId ? compiled.layout.pages.find(p => p.id === pageId) : page) }, qa: { ...state.qa, visual: 'stale' } } };
  validateV2State(next); return recordNameEdit(project,next,'ネーム配置変更');
}
export function setNameLock(project, pageId, locked) {
  const page = project.layout.pages.find(page => page.id === pageId);
  if (!page || project.namePlan?.format !== FORMAT) fail('lock', '対象ネームページがありません');
  const next = structuredClone(project.namePlan.locks);
  if (locked) next.pages[pageId] = structuredClone(page); else delete next.pages[pageId];
  return recordNameEdit(project,{ ...project, namePlan: { ...project.namePlan, locks: next } },locked ? 'ネームページを固定' : 'ネームページの固定解除');
}
export async function createNameFile(project, plan, selectedAtomIds, provenance) {
  const snapshot = project.snapshots.find(snapshot => snapshot.id === project.active), all = atomize(snapshot);
  if (!snapshot) fail('source', '原稿を先に取り込んでください');
  const atoms = selectedAtomIds?.length ? all.filter(atom => selectedAtomIds.includes(atom.id)) : all;
  const portable = portableCharacterPlan(project, snapshot, plan);
  validatePlan(portable, atoms, sourceCharacterIds(snapshot), all);
  return { format: FORMAT, title: project.title ?? 'ネーム', stage: 'name-only', readingDirection: 'rtl', source: await sourceDescriptor(project, snapshot, atoms, portable.panels.flatMap(panel => panel.contextAtomIds)), policyVersion: POLICY_VERSION, provenance, plan: portable };
}
export function canFinalizeNameRef(project, ref) {
  if (project.namePlan?.format !== FORMAT) return true;
  const entries = project.namePlan.sourcePolicy.filter(entry => intersects(entry.source, ref));
  if (!orderedCoverage([ref], entries.map(entry => ({ ...entry.source, startCp: Math.max(ref.startCp, entry.source.startCp), endCp: Math.min(ref.endCp, entry.source.endCp) })))) return false;
  const panels = project.panels.filter(panel => panel.sourceRefs?.some(r => intersects(r, ref)));
  return panels.length > 0 && panels.every(panel => panel.image && (!panel.requiredText?.length || panel.lettering && panel.letteringStatus === 'ready' && panel.letteringArtworkRevision === panel.artwork_revision));
}

export async function refreshNameBindings(project) {
  const next=refreshNameMetadata(project);
  if(next.namePlan?.format!==FORMAT)return next;
  if(await sha256(next.namePlan.file)!==next.namePlan.fileHash)fail('file_hash','保存したネームのhashが一致しません');
  if(next.namePlan.status==='stale')return next;
  try { await bindSource(next.namePlan.file,next); }
  catch(error) { if(!['references_changed','source_changed','scene_order','work'].includes(error.code))throw error; return {...next,namePlan:{...next.namePlan,status:'stale',staleReason:error.message}}; }
  return next;
}
