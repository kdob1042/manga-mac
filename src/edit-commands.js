import { NAME_EDIT_FIELDS, nameEditState, validateV2State } from './name-v2.js';
import {checkVisualEdit,regionForEdit,letteringRegions} from './visual-regions.js';
import { defaultLettering, validateLettering, setLettering, isCustomLetteringBox } from './lettering.js';
import { validateLayout, layoutWarnings, changeLayout, pagePanels } from './layout.js';
import { validateCrop } from './image-crop.js';
import { digest } from './revisions.js';
import { defaultVideoModelId, videoModel } from './media.js';

async function proposalBase(project) {
  return digest(new TextEncoder().encode(JSON.stringify([project.active,project.panels,project.layout,project.characters,project.style_references,project.output_locale,project.localizations,project.panelMotions,project.videoShots])));
}
export async function saveEditProposal(project,candidate) {
  if(candidate.base!==editBase(project))throw Error('要求後に作品が変わりました。現在の原稿から再提案してください');
  validateEditPlan(project,candidate.plan,candidate.context);
  const job={id:crypto.randomUUID(),kind:'edit_proposal',status:'candidate',source_revision:project.active,at:new Date().toISOString(),input_hash:await proposalBase(project),plan:candidate.plan,context:candidate.context};
  return {...project,jobs:[...project.jobs,job]};
}
export async function loadEditProposal(project,id) {
  const job=project.jobs.find(j=>j.id===id&&j.kind==='edit_proposal');
  if(!job||job.status!=='candidate')throw Error('編集候補がありません');
  if(project.jobs.some(j=>j.kind==='edit_execution'&&j.proposal_id===id))throw Error('実行を開始済みの候補です。保存結果・未確定要求を確認してください');
  if(job.input_hash!==await proposalBase(project))throw Error('原稿が変わった候補です。現在の原稿から再提案してください');
  validateEditPlan(project,job.plan,job.context);
  return {base:editBase(project),plan:job.plan,context:job.context,jobId:job.id};
}
export function resolveEditProposal(project,id,status) {
  if(!['complete','abandoned'].includes(status))throw Error('候補の状態が不正です');
  return {...project,jobs:project.jobs.map(j=>j.id===id&&j.kind==='edit_proposal'?{...j,status}:j)};
}

// The registry describes only executable operations. No generated code or URLs.
export const commands = {
  lettering: { label: '文字配置', generation: false },
  crop: { label: '画像配置', generation: false },
  layout: { label: 'コマ割り', generation: false },
  direction: { label: '3D構図', generation: true },
  region: { label: '指定領域の修正', generation: true },
  resolution: {label:'解像度診断',generation:false,runner:true},
  upscale: {label:'補間拡大候補',generation:false,runner:true},
  finishing: {label:'配置に合わせた仕上げ候補',generation:true,runner:true},
  video_prepare: {label:'動画の準備',generation:false,runner:true},
  video_assign: {label:'保存済み動画の割当',generation:false,runner:true},
};
export function editBase(project) { return JSON.stringify([project.revision ?? 0, project.active, project.panels, project.layout]); }
export function editContext(project, pageIndex, selected, rect) {
  const page = project.layout.pages[pageIndex];
  if (!page) throw Error('表示ページがありません');
  const previous=project.jobs.findLast(j=>j.kind==='edit_proposal'&&j.status==='complete'&&j.context?.pageId===page.id);
  return { pageId: page.id, pageNumber: pageIndex + 1, selected: page.slots.some(s => s.panelId === selected) ? selected : null,
    previousTargets:previous?.plan.operations.map(op=>op.panelId).filter(id=>page.slots.some(s=>s.panelId===id))??[],
    panels: pagePanels(project, page).map((p, i) => ({ id: p.id, number: i + 1, characterIds: p.characterIds, lettering: p.lettering ?? defaultLettering(p), crop: project.layout.imageCrops?.[p.id] ?? null, hasImage: !!p.image })),
    videoShots: (project.videoShots??[]).filter(s=>s.adopted_revision).map(s=>({id:s.id,sceneId:s.sceneId,unitIds:s.unitIds})),
    pages: [page], region: rect ?? null, operations: Object.keys(commands) };
}
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
export function validateEditPlan(project, plan, context) {
  if (!exact(plan, ['reason','operations']) || typeof plan.reason !== 'string' || !plan.reason.trim() || plan.reason.length > 2000 || !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 8) throw Error('編集内容が不明です。対象と変更内容を具体的にしてください');
  const targets = new Set(context.panels.map(p => p.id));
  let generationStarted=false;
  const generated=new Set();
  let preview = project;
  for (const op of plan.operations) {
    if (!exact(op, ['kind','panelId','args']) || !commands[op.kind] || !object(op.args)) throw Error('未対応の編集操作です');
    if(commands[op.kind].generation||commands[op.kind].runner) {
      generationStarted=true;
      if(plan.operations.length>1&&['resolution','video_prepare','video_assign'].includes(op.kind))throw Error('診断・動画の準備と割当は個別に実行してください');
      if(generated.has(op.panelId))throw Error('同じコマへの複数の生成は、先の候補を採用してから指示してください');
      generated.add(op.panelId);
    } else if(generationStarted)throw Error('文字・枠・cropの調整を先に、生成を後にする計画が必要です');
    if (op.kind !== 'layout' && !targets.has(op.panelId)) throw Error('表示ページ外の対象は変更できません');
    if (context.explicitTargets?.length && op.kind!=='layout' && !context.explicitTargets.includes(op.panelId)) throw Error('指示で指定されたコマ以外への変更は実行しません');
    const p = preview.panels.find(p => p.id === op.panelId);
    if (op.kind === 'lettering') {
      validateLettering(p, op.args);
      const previous = p.lettering ?? defaultLettering(p);
      if (previous.boxes.some(b=>b.locked) && previous.mode!==op.args.mode) throw Error('固定した文字配置の表示方法は変更できません');
      for (const b of previous.boxes) { const match = x => p.sourceRefs || isCustomLetteringBox(b) ? x.id === b.id : x.unit_id === b.unit_id; if (b.locked && JSON.stringify(b) !== JSON.stringify(op.args.boxes.find(match))) throw Error('固定した吹き出しは変更できません'); }
      preview = setLettering(preview,p.id,op.args);
    } else if (op.kind === 'crop') {
      if (!p.image || !exact(op.args,['x','y','zoom'])) throw Error('画像配置の対象・引数が不正です');
      validateCrop(op.args);
      preview = changeLayout(preview, {...preview.layout,imageCrops:{...preview.layout.imageCrops,[p.id]:op.args}},'画像配置',{pageIds:[context.pageId]});
    } else if (op.kind === 'layout') {
      if (!exact(op.args,['pages']) || !Array.isArray(op.args.pages) || op.args.pages.length !== 1 || op.args.pages[0].id !== context.pageId) throw Error('コマ割りは表示ページだけを変更できます');
      const before = preview.layout.pages.find(pg => pg.id === context.pageId);
      if(context.explicitTargets?.length && before.slots.some(slot=>!context.explicitTargets.includes(slot.panelId) && JSON.stringify(slot)!==JSON.stringify(op.args.pages[0].slots.find(s=>s.id===slot.id))))throw Error('対象外のコマ枠を変更する案は採用できません');
      if (JSON.stringify(before.slots.map(s=>s.panelId)) !== JSON.stringify(op.args.pages[0].slots.map(s=>s.panelId))) throw Error('コマの追加・削除・本文の再分割はこの編集ではできません');
      const layout = {...preview.layout,pages:preview.layout.pages.map(pg=>pg.id===context.pageId?op.args.pages[0]:pg)};
      validateLayout(layout,preview.panels);
      if(layoutWarnings(layout,preview.panels).length) throw Error('枠の重なり・未割当・読書順を確認してください');
      preview=changeLayout(preview,layout,'コマ割り',{pageIds:[context.pageId]});
    } else if(commands[op.kind].runner) {
      if(!p.image)throw Error('採用済み作画が必要です');
      if(['resolution','finishing'].includes(op.kind) && !exact(op.args,[]))throw Error('操作の引数が不正です');
      if(op.kind==='upscale' && (!exact(op.args,['factor']) || ![2,4].includes(op.args.factor)))throw Error('補間拡大は2倍または4倍を指定してください');
      if(op.kind==='video_prepare' && (!exact(op.args,['instruction','ratio']) || typeof op.args.instruction!=='string' || !op.args.instruction.trim() || op.args.instruction.length>1000 || !videoModel(project.mediaDefaults?.video ?? defaultVideoModelId).input.ratios.includes(op.args.ratio)))throw Error('動画の指示と対応寸法を指定してください');
      if(op.kind==='video_assign' && (!exact(op.args,['shotId']) || !context.videoShots?.some(s=>s.id===op.args.shotId)))throw Error('保存済みの採用動画を指定してください');
    } else {
      if (!exact(op.args,['instruction']) || typeof op.args.instruction !== 'string' || !op.args.instruction.trim() || op.args.instruction.length > 4000) throw Error('再生成の指示が不正です');
      if (op.kind==='region') {if(!p.image)throw Error('採用済み作画が必要です');regionForEdit(context,p.id);}
    }
  }
  for(const op of plan.operations)checkVisualEdit(preview,op,context.visual);
  return preview;
}
export function executeLocalEdits(project, candidate) {
  if(candidate.base!==editBase(project)) throw Error('要求後に作品が変わりました。候補を作り直してください');
  if(candidate.plan.operations.some(op=>(commands[op.kind]?.generation||commands[op.kind]?.runner))) throw Error('生成操作は専用の候補経路で実行してください');
  const next=validateEditPlan(project,candidate.plan,candidate.context);
  // Reuse the manga history, retaining independent video/artwork state.
  return {...next,layoutHistory:project.layoutHistory,layoutRedo:project.layoutRedo,history:[...project.history,{panels:project.panels,layout:project.layout,edit:true,after:{panels:next.panels,layout:next.layout},label:candidate.plan.reason}],editRedo:[]};
}
export function undoEdit(project, redo=false) {
  const from=redo?'editRedo':'history',entry=project[from]?.at(-1);
  if(!entry) return project;
  if(entry.nameEdit) {
    const expected=redo?entry:entry.after,target=redo?entry.after:entry;
    if(JSON.stringify(nameEditState(project))!==JSON.stringify(nameEditState(expected)))throw Error('別の編集があるため先にその操作を戻してください');
    const restored=Object.fromEntries(NAME_EDIT_FIELDS.map(key=>[key,structuredClone(target[key])]));
    const next={...project,...restored,history:redo?[...project.history,entry]:project.history.slice(0,-1),editRedo:redo?(project.editRedo??[]).slice(0,-1):[...(project.editRedo??[]),entry]};
    validateV2State(next);return next;
  }
  if(entry.draftCheckpoint) throw Error('原稿の切替は「保存した原稿」から行ってください');
  if(entry.sourcePatch) {
    const fields=['panels','layout','sourceApplication',...['layoutHistory','layoutRedo'].filter(k=>entry[k]!==undefined)],expected=redo?entry:entry.after,target=redo?entry.after:entry;
    if(fields.some(key=>JSON.stringify(project[key])!==JSON.stringify(expected[key])))throw Error('別の編集があるため先にその操作を戻してください');
    const restored=Object.fromEntries(fields.map(key=>[key,structuredClone(target[key])]));
    return {...project,...restored,history:redo?[...project.history,entry]:project.history.slice(0,-1),editRedo:redo?project.editRedo.slice(0,-1):[...(project.editRedo??[]),entry]};
  }
  if(entry.contentReplan) {
    const currentState=[project.panels,project.layout,project.layoutHistory??[],project.layoutRedo??[]];
    const expectedState=redo?[entry.panels,entry.layout,entry.layoutHistory??[],entry.layoutRedo??[]]:[entry.after.panels,entry.after.layout,entry.after.layoutHistory??[],entry.after.layoutRedo??[]];
    if(JSON.stringify(currentState)!==JSON.stringify(expectedState)) throw Error('別の編集があるため先にその操作を戻してください');
    const state=redo?entry.after:{...(entry.sourceApplication?{sourceApplication:entry.sourceApplication}:{}),panels:entry.panels,layout:entry.layout,layoutHistory:entry.layoutHistory??[],layoutRedo:entry.layoutRedo??[]};
    return {...project,...state,history:redo?[...project.history,entry]:project.history.slice(0,-1),editRedo:redo?(project.editRedo??[]).slice(0,-1):[...(project.editRedo??[]),entry]};
  }
  if(!entry.edit) {
    if(redo) return project;
    return {...project,...(entry.sourceApplication?{sourceApplication:entry.sourceApplication}:{}),panels:entry.panels,history:project.history.slice(0,-1),editRedo:[]};
  }
  const expected=redo?{panels:entry.panels,layout:entry.layout}:entry.after;
  if(JSON.stringify([project.panels,project.layout])!==JSON.stringify([expected.panels,expected.layout])) throw Error('別の編集があるため先にその操作を戻してください');
  const state=redo?entry.after:{...(entry.sourceApplication?{sourceApplication:entry.sourceApplication}:{}),panels:entry.panels,layout:entry.layout};
  return {...project,...state,history:redo?[...project.history,entry]:project.history.slice(0,-1),editRedo:redo?project.editRedo.slice(0,-1):[...(project.editRedo??[]),entry]};
}
export const editPlanSchema = {type:'object',properties:{reason:{type:'string'},operations:{type:'array',minItems:0,maxItems:8,items:{type:'object',properties:{kind:{type:'string',enum:Object.keys(commands)},panelId:{type:'string'},args:{type:'object'}},required:['kind','panelId','args'],additionalProperties:false}}},required:['reason','operations'],additionalProperties:false};
export async function planEdit(project,context,instruction,ask,classify,recognize) {
  const base=editBase(project);
  const normalized=instruction.normalize('NFKC');
  const pageNumbers=[...normalized.matchAll(/(\d+)ページ目/g)].map(m=>Number(m[1]));
  if(pageNumbers.some(n=>n!==context.pageNumber))throw Error('そのページを表示してから修正してください');
  const numbers=[...normalized.matchAll(/(\d+)コマ目/g)].map(m=>Number(m[1]));
  if(numbers.some(n=>!context.panels.some(p=>p.number===n)))throw Error('指定のコマが表示ページにありません');
  context={...context,explicitTargets:numbers.length?numbers.map(n=>context.panels.find(p=>p.number===n).id):(/このコマ/.test(normalized)&&context.selected?[context.selected]:[])};
  if(!context.explicitTargets.length&&/さっき|直前/.test(normalized)) {
    if(new Set(context.previousTargets).size!==1)throw Error('直前の対象を一つに特定できません。コマ番号で指定してください');
    context.explicitTargets=[context.previousTargets[0]];
  }
  const needsVisual=/顔|服|衣装|頭.*切れ|しっぽ|手.*避け|右側の人物|左側の人物/.test(normalized);
  if(needsVisual&&!context.region) {
    if(!recognize)throw Error('画像の対象認識には接続設定で作画画像の送信を有効にするか、修正範囲を手動指定してください');
    const ids=context.explicitTargets.length?context.explicitTargets:context.selected?[context.selected]:context.panels.map(p=>p.id);
    const visual=await recognize(ids,instruction);
    context={...context,visual,letteringRegions:Object.fromEntries(ids.map(id=>[id,letteringRegions(project,id,visual)]))};
  }
  const decision=classify?await classify(instruction,context):null;
  if(decision && ['unclear','unsupported','readonly'].includes(decision.choice)) throw Error('変更内容を確認してください。原文変更・未対応操作は実行しません');
  const prompt=JSON.stringify({task:'漫画の編集計画をJSONで返す。対象は表示ページの読書順numberからidへ解決。明示対象がない時だけselectedを使う。曖昧/未対応ならoperations空。原文とunit_id順序、固定locked枠、対象外を保持。画像内の位置はcontext.visualとletteringRegionsだけを根拠にする。letteringRegionsは文字枠と同じ座標でavoidに文字を重ねない。subjectの矩形へしっぽ先端を向ける。根拠がなければ推測せず確認する。lettering argsは完全な{mode,boxes}、crop argsは{x,y,zoom}（x/yは切り取り基準、右へ動かす時はxを減らす）、layout argsは{pages:[表示ページ]}。direction/region argsは{instruction}。regionは手選択済み領域またはvisualのedit矩形を使う。文字の内容は変更できない。文字サイズfontSizeは14〜72、lineHeightは1〜2、paddingは0〜40。複数の軽い変更は操作順に分ける。resolution/finishing argsは{}、upscaleは{factor:2または4}。video_prepareは{instruction,ratio}で5秒無音動画の準備のみ（生成しない）。video_assignは{shotId}でvideoShotsの既存採用動画を選ぶ。複合操作は文字・枠・cropを先にまとめ、その後に生成する順序にする。同じコマの連続生成は先の採用が必要なため分ける。診断・動画準備・動画割当は単独操作。',instruction,context,decision});
  const plan=JSON.parse(await ask(prompt,editPlanSchema));
  // Moving a box must not silently reset typography omitted by the model.
  // Carry explicit changes forward for a later lettering operation in this plan.
  const typography = new Map(project.panels.map(panel => [panel.id, panel.lettering ?? defaultLettering(panel)]));
  for (const op of Array.isArray(plan?.operations) ? plan.operations : []) {
    if (op?.kind !== 'lettering' || !Array.isArray(op.args?.boxes)) continue;
    const previous = typography.get(op.panelId);
    op.args.boxes = op.args.boxes.map(box => {
      if (!object(box)) return box;
      const before = previous?.boxes.find(old => isCustomLetteringBox(old) || Array.isArray(old.sourceRefs) ? old.id === box.id : old.unit_id === box.unit_id);
      return { ...(before?.writingMode !== undefined ? {writingMode:before.writingMode} : {}),
        ...(before?.fontFamily !== undefined ? {fontFamily:before.fontFamily} : {}), ...box };
    });
    typography.set(op.panelId, op.args);
  }
  validateEditPlan(project,plan,context);
  return {base,context,plan};
}

export async function executeEditSequence({current,commit,candidate,perform,check,cancelled=()=>false}) {
  if(candidate.base!==editBase(current()))throw Error('要求後に作品が変わりました');
  const preview=validateEditPlan(current(),candidate.plan,candidate.context);
  if(check)await check(preview);
  if(cancelled())return;
  if(candidate.base!==editBase(current()))throw Error('検証中に作品が変わりました');
  const local=candidate.plan.operations.filter(op=>!commands[op.kind].generation&&!commands[op.kind].runner);
  const generated=candidate.plan.operations.filter(op=>commands[op.kind].generation||commands[op.kind].runner);
  const id=crypto.randomUUID();
  if(generated.length)await commit({...current(),jobs:[...current().jobs,{id,kind:'edit_execution',status:'running',source_revision:current().active,proposal_id:candidate.jobId??null,operations:candidate.plan.operations,completed:0}]});
  let completed=0;
  const record=async(status)=>{if(generated.length)await commit({...current(),jobs:current().jobs.map(j=>j.id===id?{...j,status,completed}:j)});};
  try {
    if(local.length) {
      await commit(executeLocalEdits(current(),{...candidate,base:editBase(current()),plan:{...candidate.plan,operations:local}}));
      completed=local.length;await record('running');
    }
    for(const op of generated) {
      if(cancelled())throw Error('途中で停止しました。保存済みの編集と候補は保持しています');
      await perform(op,candidate.context);
      if(cancelled())throw Error('途中で停止しました。生成結果は候補・復旧欄を確認してください');
      completed++;await record('running');
    }
    await record('complete');
  }catch(e){await record('partial');throw Error(`${e.message}（保存済み ${completed}/${candidate.plan.operations.length} 操作。自動再送はしません）`);}
}
