import { FORMAT, validateV2State, canFinalizeNameRef, requiredTextForSource, recordNameEdit } from './name-v2.js';
import { bindSource, sourceParagraphs, intersects, orderedCoverage, clipRefs } from '../contracts/name-plan/source.mjs';
import { canonical, fail } from '../contracts/name-plan/schema.mjs';
import { hasEmbeddedSource } from '../contracts/name-plan/source.mjs';
import { nameSourceSnapshot } from './name-parts.js';

export function nameGenerationSize(points, descriptor, longEdge = 1024) {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const width = (Math.max(...xs) - Math.min(...xs)) * 1600, height = (Math.max(...ys) - Math.min(...ys)) * 2260, aspect = width / height;
  if (!Number.isFinite(aspect) || aspect < .25 || aspect > 4) fail('image_aspect', 'このコマ比率は画像モデルの入力範囲外です。構図または画像配置を確認してください');
  const input = descriptor.input, step = input.step;
  if (!Number.isInteger(step) || step < 1 || step > 1024) fail('image_model', 'モデルの寸法刻みが不正です');
  const maxW = Math.min(input.max_width, longEdge), maxH = Math.min(input.max_height, longEdge), sizes = [];
  for (let w = Math.ceil(input.min_width / step) * step; w <= maxW; w += step) for (let h = Math.ceil(input.min_height / step) * step; h <= maxH; h += step) {
    if (w / h < .25 || w / h > 4 || input.max_pixels && w * h > input.max_pixels) continue;
    const ratioError = Math.abs(w / h / aspect - 1);
    if (ratioError <= .03) sizes.push({ width: w, height: h, ratioError, pixels: w * h });
  }
  sizes.sort((a, b) => a.ratioError - b.ratioError || b.pixels - a.pixels || b.width - a.width);
  const bestError = sizes[0]?.ratioError;
  const best = sizes.filter(size => size.ratioError <= (bestError ?? 0) + .005).sort((a, b) => b.pixels - a.pixels || a.ratioError - b.ratioError)[0];
  if (!best) fail('image_dimensions', 'コマ比率を保てる生成寸法がありません。別のモデルまたは構図を明示的に選んでください');
  return { resolution: [best.width, best.height], requestedAspect: aspect, actualAspect: best.width / best.height, ratioError: best.ratioError, resolutionPolicy: 'preserve-panel-aspect/1' };
}
export function finalizeNameApplication(project) {
  validateV2State(project, { complete: true });
  const snapshot = nameSourceSnapshot(project), old = project.sourceApplication?.units ?? [];
  const additions = sourceParagraphs(snapshot).filter(unit => canFinalizeNameRef(project, unit.source)).map(unit => ({ id: `name-source:${snapshot.id}:${unit.id}`, source: unit.source, requiredText: requiredTextForSource(project, unit.source) }));
  const kept = old.filter(unit => !additions.some(next => intersects(next.source, unit.source)));
  for (const unit of old) {
    const matching = additions.filter(next => intersects(next.source, unit.source));
    if (matching.length && !orderedCoverage([unit.source], clipRefs(matching.map(next => next.source), unit.source))) fail('application', '選択外の完了原稿を変更する更新です');
  }
  const rank = unit => project.panels.findIndex(panel => panel.sourceRefs?.some(ref => intersects(ref, unit.source)));
  const units = [...kept, ...additions].sort((a, b) => rank(a) - rank(b) || a.source.startCp - b.source.startCp);
  return recordNameEdit(project,{ ...project, sourceApplication: { version: 1, units }, namePlan: { ...project.namePlan, productionState: 'proof-ready', completedAt: new Date().toISOString() } },'ネーム初稿の完了反映');
}
function contractKey(project) {
  return canonical({ active: project.active, fileHash: project.namePlan?.fileHash, layout: project.layout, characters: project.characters.map(({ id, hash, description }) => ({ id, hash: hash ?? '', description: description ?? '' })), settings: project.snapshots.find(s => s.id === project.active)?.settings ?? [] });
}
// Uses the same batch jobs, lettering stage, renderer and checked native save as ordinary production.
export async function produceNameDraft(args) {
  const { current, commit, cancelled, model, setBusy, setNotice, showProof, generatePanel, askLLM, imageOf, pagePNG, imageModelId } = args;
  const initial = current();
  if (initial.namePlan?.format !== FORMAT || initial.namePlan.status !== 'adopted' || (!hasEmbeddedSource(initial.namePlan.file) && initial.namePlan.snapshotId !== initial.active)) fail('name', '制作する確定ネームを選んでください');
  await bindSource(initial.namePlan.file, initial); validateV2State(initial);
  const ids = [...initial.namePlan.panelIds], descriptor = args.resolveModel ? args.resolveModel(imageModelId) : (await import('./media.js')).imageModel(imageModelId ?? initial.mediaDefaults?.image);
  const placements = initial.layout.pages.flatMap(page => page.slots);
  const panels = initial.panels.map(panel => {
    if (!ids.includes(panel.id) || panel.image) return panel;
    const slot = placements.find(slot => slot.panelId === panel.id);
    const size = nameGenerationSize(slot.points, descriptor);
    return { ...panel, generationResolution: size.resolution, nameGeneration: size };
  });
  if (!same(panels, initial.panels)) await commit({ ...initial, panels });
  const frozen = contractKey(current()), changed = () => frozen !== contractKey(current()), stop = () => cancelled() || changed();
  if (stop()) { setNotice('停止しました。確定ネームと保存済み結果は保持しています'); return; }
  const batch = args.generateBatch ?? (await import('./production.js')).producePanels;
  const result=await batch({ current, commit, panelIds: ids, generate: generatePanel, cancelled: stop, notify: setBusy, imageModelId });
  if (stop()) { setNotice('停止しました。生成済み画像は保持し、入力が変わった結果は候補のままです'); return; }
  const finish = args.finishText ?? (await import('./draft.js')).finishDraftLettering;
  let recognize = null;
  if (model.visualEditing) {
    const { recognizeRegions } = await import('./visual-regions.js');
    recognize = (project, panel) => recognizeRegions(project, [panel.id], '顔・手・視線・重要物を文字で覆わない', (prompt, schema, images) => askLLM(model, { purpose: 'vision', prompt, schema, images }), imageOf);
  }
  await finish({ current, commit, panelIds: ids, cancelled: stop, notify: setBusy, recognize,
    ask: (prompt, schema) => askLLM(model, { purpose: 'lettering', prompt, schema }),
    check: async (project, id) => { const page = project.layout.pages.find(page => page.slots.some(slot => slot.panelId === id)); await pagePNG(page.slots.map(slot => project.panels.find(panel => panel.id === slot.panelId)).filter(Boolean), project.snapshots, project.localizations ?? [], project.output_locale ?? 'ja', page, true, project.layout.imageCrops); },
  });
  if (stop()) { setNotice('停止しました。作画・文字配置は保存済みです'); return; }
  if(result?.missingReferences?.length){
    setNotice(`参照画像がありません: ${[...new Set(result.missingReferences.flatMap(item=>item.characterIds))].join('、')}。他のコマの作画は保存しました。画像を登録して再開できます`);
    return {state:'missing-references',missingReferences:result.missingReferences};
  }
  validateV2State(current(), { complete: true });
  const proofs = [];
  for (const pageId of current().namePlan.pageIds) {
    const project = current(), page = project.layout.pages.find(page => page.id === pageId), panels = page.slots.map(slot => project.panels.find(panel => panel.id === slot.panelId));
    proofs.push(await pagePNG(panels, project.snapshots, project.localizations ?? [], project.output_locale ?? 'ja', page, false, project.layout.imageCrops));
  }
  // saveProject performs native CAS + validation + atomic SQLite save and readback.
  await commit(finalizeNameApplication(current()));
  showProof(proofs[0],current().layout.pages.findIndex(page=>page.id===current().namePlan.pageIds[0]));
  setNotice(`確定ネームの初稿 ${proofs.length}ページを表示しました。人物・文字・演出の見た目は確認してください。公開・転送はしていません。`);
  return { proofs, panelIds: ids, state: 'proof-ready' };
}
function same(a, b) { return canonical(a) === canonical(b); }
