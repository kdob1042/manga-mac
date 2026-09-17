import { defaultLettering, validateLettering, setLettering } from './lettering.js';
import { validateLayout, layoutWarnings, changeLayout, pagePanels } from './layout.js';
import { validateCrop } from './image-crop.js';

// The registry describes only executable operations. No generated code or URLs.
export const commands = {
  lettering: { label: '文字配置', generation: false },
  crop: { label: '画像配置', generation: false },
  layout: { label: 'コマ割り', generation: false },
  direction: { label: 'Blender演出', generation: true },
  region: { label: '指定領域の修正', generation: true },
};
export function editBase(project) { return JSON.stringify([project.revision ?? 0, project.active, project.panels, project.layout]); }
export function editContext(project, pageIndex, selected, rect) {
  const page = project.layout.pages[pageIndex];
  if (!page) throw Error('表示ページがありません');
  return { pageId: page.id, pageNumber: pageIndex + 1, selected: page.slots.some(s => s.panelId === selected) ? selected : null,
    panels: pagePanels(project, page).map((p, i) => ({ id: p.id, number: i + 1, characterIds: p.characterIds, lettering: p.lettering ?? defaultLettering(p), crop: project.layout.imageCrops?.[p.id] ?? null, hasImage: !!p.image })),
    pages: [page], region: rect ?? null, operations: Object.keys(commands) };
}
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
export function validateEditPlan(project, plan, context) {
  if (!exact(plan, ['reason','operations']) || typeof plan.reason !== 'string' || !plan.reason.trim() || plan.reason.length > 2000 || !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 8) throw Error('編集内容が不明です。対象と変更内容を具体的にしてください');
  const targets = new Set(context.panels.map(p => p.id));
  let preview = project;
  for (const op of plan.operations) {
    if (!exact(op, ['kind','panelId','args']) || !commands[op.kind] || !object(op.args)) throw Error('未対応の編集操作です');
    if (op.kind !== 'layout' && !targets.has(op.panelId)) throw Error('表示ページ外の対象は変更できません');
    const p = preview.panels.find(p => p.id === op.panelId);
    if (op.kind === 'lettering') {
      validateLettering(p, op.args);
      const previous = p.lettering ?? defaultLettering(p);
      for (const b of previous.boxes) if (b.locked && JSON.stringify(b) !== JSON.stringify(op.args.boxes.find(x => x.unit_id === b.unit_id))) throw Error('固定した吹き出しは変更できません');
      preview = setLettering(preview,p.id,op.args);
    } else if (op.kind === 'crop') {
      if (!p.image || !exact(op.args,['x','y','zoom'])) throw Error('画像配置の対象・引数が不正です');
      validateCrop(op.args);
      preview = changeLayout(preview, {...preview.layout,imageCrops:{...preview.layout.imageCrops,[p.id]:op.args}},'画像配置');
    } else if (op.kind === 'layout') {
      if (!exact(op.args,['pages']) || !Array.isArray(op.args.pages) || op.args.pages.length !== 1 || op.args.pages[0].id !== context.pageId) throw Error('コマ割りは表示ページだけを変更できます');
      const before = preview.layout.pages.find(pg => pg.id === context.pageId);
      if (JSON.stringify(before.slots.map(s=>s.panelId)) !== JSON.stringify(op.args.pages[0].slots.map(s=>s.panelId))) throw Error('コマの追加・削除・本文の再分割はこの編集ではできません');
      const layout = {...preview.layout,pages:preview.layout.pages.map(pg=>pg.id===context.pageId?op.args.pages[0]:pg)};
      validateLayout(layout,preview.panels);
      if(layoutWarnings(layout,preview.panels).length) throw Error('枠の重なり・未割当・読書順を確認してください');
      preview=changeLayout(preview,layout,'コマ割り');
    } else {
      if (plan.operations.length !== 1) throw Error('再生成を含む複合指示は一つずつ実行してください。まだ変更していません');
      if (!exact(op.args,['instruction']) || typeof op.args.instruction !== 'string' || !op.args.instruction.trim() || op.args.instruction.length > 4000) throw Error('再生成の指示が不正です');
      if (op.kind==='region' && (!p.image || !context.region || context.selected!==p.id)) throw Error('この画像の修正範囲をドラッグで指定してください。自動領域認識は未対応です');
    }
  }
  return preview;
}
export function executeLocalEdits(project, candidate) {
  if(candidate.base!==editBase(project)) throw Error('要求後に作品が変わりました。候補を作り直してください');
  if(candidate.plan.operations.some(op=>commands[op.kind]?.generation)) throw Error('生成操作は専用の候補経路で実行してください');
  const next=validateEditPlan(project,candidate.plan,candidate.context);
  // Reuse the manga history, retaining independent video/artwork state.
  return {...next,layoutHistory:project.layoutHistory,layoutRedo:project.layoutRedo,history:[...project.history,{panels:project.panels,layout:project.layout,edit:true,after:{panels:next.panels,layout:next.layout},label:candidate.plan.reason}],editRedo:[]};
}
export function undoEdit(project, redo=false) {
  const from=redo?'editRedo':'history',entry=project[from]?.at(-1);
  if(!entry) return project;
  if(!entry.edit) {
    if(redo) return project;
    return {...project,panels:entry.panels,history:project.history.slice(0,-1),editRedo:[]};
  }
  const expected=redo?{panels:entry.panels,layout:entry.layout}:entry.after;
  if(JSON.stringify([project.panels,project.layout])!==JSON.stringify([expected.panels,expected.layout])) throw Error('別の編集があるため先にその操作を戻してください');
  const state=redo?entry.after:{panels:entry.panels,layout:entry.layout};
  return {...project,...state,history:redo?[...project.history,entry]:project.history.slice(0,-1),editRedo:redo?project.editRedo.slice(0,-1):[...(project.editRedo??[]),entry]};
}
export const editPlanSchema = {type:'object',properties:{reason:{type:'string'},operations:{type:'array',minItems:0,maxItems:8,items:{type:'object',properties:{kind:{type:'string',enum:Object.keys(commands)},panelId:{type:'string'},args:{type:'object'}},required:['kind','panelId','args'],additionalProperties:false}}},required:['reason','operations'],additionalProperties:false};
export async function planEdit(project,context,instruction,ask,classify) {
  const base=editBase(project);
  const decision=classify?await classify(instruction,context):null;
  if(decision && ['unclear','unsupported','readonly'].includes(decision.choice)) throw Error('変更内容を確認してください。原文変更・未対応操作は実行しません');
  const prompt=JSON.stringify({task:'漫画の編集計画をJSONで返す。対象は表示ページの読書順numberからidへ解決。明示対象がない時だけselectedを使う。曖昧/未対応ならoperations空。原文とunit_id順序、固定locked枠、対象外を保持。画像内の顔や服の位置を推測しない。視覚的な位置指定は未対応として確認する。lettering argsは完全な{mode,boxes}、crop argsは{x,y,zoom}（x/yは切り取り基準、右へ動かす時はxを減らす）、layout argsは{pages:[表示ページ]}。direction/region argsは{instruction}。regionは手選択済み領域のみ。文字の内容は変更できない。文字サイズfontSizeは14〜72、lineHeightは1〜2、paddingは0〜40。複数の軽い変更は操作順に分ける。画像再生成を伴う複合操作は未対応。',instruction,context,decision});
  const plan=JSON.parse(await ask(prompt,editPlanSchema));
  validateEditPlan(project,plan,context);
  return {base,context,plan};
}
