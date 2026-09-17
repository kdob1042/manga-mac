import { proposeLayout, adoptLayoutProposal } from './layout-ai.js';
import { proposeLettering } from './lettering-ai.js';
import { setLettering } from './lettering.js';
import { panelHasText, sourceUnits } from './core.js';
import { editBase } from './edit-commands.js';
import { pagePanels, initialLayout, validateLayout, layoutWarnings } from './layout.js';

export function draftScenes(project, ids = project.draftScope?.sceneIds) {
  const snapshot = project.snapshots.find(s => s.id === project.active);
  if (!snapshot) throw Error('初稿の原作がありません');
  const selected = ids ?? snapshot.scenes.map(s => s.id);
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(id => !snapshot.scenes.some(s => s.id === id))) throw Error('制作する場面を選んでください');
  return snapshot.scenes.filter(s => selected.includes(s.id));
}

// A checkpoint is an immutable entry in the existing manga history, not a second workspace.
const draftFields = ['sourceApplication','panels','layout','layoutHistory','layoutRedo','panelMotions','motionHistory','draftScope','characters','style_references','output_locale'];
function checkpoint(project) {
  const state = Object.fromEntries(draftFields.map(key => [key, structuredClone(project[key] ?? (key === 'sourceApplication' ? {version:1,units:[]} : key === 'draftScope' ? null : key === 'output_locale' ? 'ja' : []))]));
  return {...state, id:crypto.randomUUID(), draftCheckpoint:true, active:project.active,
    label:`${project.draftScope?.sceneIds?.join('・') ?? '原稿'} / ${new Date().toISOString()}`, at:new Date().toISOString()};
}
export function preserveDraft(project) {
  return project.panels.length ? {...project,history:[...project.history,checkpoint(project)],editRedo:[]} : project;
}
function assertSwitchable(project) {
  const ids = new Set(project.panels.map(p => p.id));
  if (project.jobs.some(j => ids.has(j.panelId) && ['running','unknown'].includes(j.status) && ['generate','edit','retake'].includes(j.kind)) || project.directing_runs?.some(r => ids.has(r.panel_id) && !['complete','abandoned','failed'].includes(r.status))) throw Error('応答未確定の制作を解決してから原稿を切り替えてください');
}
export function startDraft(project, sceneIds, separate = false) {
  const scenes = draftScenes(project, sceneIds), ids = scenes.map(s => s.id);
  const scope = {id:crypto.randomUUID(),snapshotId:project.active,sceneIds:ids};
  if (!separate) {
    if (project.panels.some(p => !ids.includes(p.sceneId) || p.snapshotId !== project.active)) throw Error('既存原稿の範囲・原作版が異なります。「別の初稿を作る」を選んでください');
    if (project.draftScope && (project.draftScope.snapshotId !== project.active || JSON.stringify(project.draftScope.sceneIds) !== JSON.stringify(ids))) throw Error('制作範囲を変更するには別の初稿を作ってください');
    return {...project,draftScope:project.draftScope ?? scope};
  }
  assertSwitchable(project);
  return {...project, history:[...project.history,checkpoint(project)], panels:[],...(project.sourceApplication?{sourceApplication:{version:1,units:[]}}:{}),layout:initialLayout([]),layoutHistory:[],layoutRedo:[],editRedo:[],panelMotions:[],motionHistory:[],draftScope:scope};
}
export function restoreDraft(project, id) {
  assertSwitchable(project);
  const entry = project.history.find(h => h.draftCheckpoint && h.id === id);
  if (!entry || !project.snapshots.some(s => s.id === entry.active)) throw Error('保存した原稿がありません');
  validateLayout(entry.layout,entry.panels);
  const state = Object.fromEntries(draftFields.map(key => [key,structuredClone(entry[key])]));
  return {...project,...state,active:entry.active,history:[...project.history,checkpoint(project)],editRedo:[]};
}

export function draftPageStatus(project, page) {
  const panels = pagePanels(project,page);
  if (!panels.length || panels.length !== page.slots.length) return '未割当';
  if (panels.some(p=>!p.image)) return '作画待ち';
  if (panels.some(p=>panelHasText(p)&&!p.lettering)) return '文字配置待ち';
  return '見た目を確認';
}
// Sequential domain stages persisted in the existing jobs. Image jobs stay authoritative.
export async function prepareDraftLayout({current,commit,ask,cancelled}) {
  const p=current(),scope=p.layout.pages.map(pg=>pg.id);
  if(!scope.length || p.panels.some(p=>p.image) || p.layoutHistory?.length || p.jobs.some(j=>j.kind==='draft_layout'&&j.status==='complete'&&j.source_revision===p.active&&j.draft_id===p.draftScope?.id))return;
  const job={id:crypto.randomUUID(),kind:'draft_layout',status:'running',source_revision:p.active,draft_id:p.draftScope?.id};
  await commit({...p,jobs:[...p.jobs,job]});
  const base=editBase(current());
  try {
    const candidate=await proposeLayout(current(),scope,'初稿。文字量と演出に合わせてページを構成してください',ask);
    if(cancelled()||base!==editBase(current()))throw Error('初稿の配置を停止しました。保存済みの内容は保持しています');
    const next=adoptLayoutProposal(current(),candidate);
    await commit({...next,jobs:next.jobs.map(j=>j.id===job.id?{...j,status:'complete'}:j)});
  }catch(e){await commit({...current(),jobs:current().jobs.map(j=>j.id===job.id?{...j,status:'failed'}:j)});throw e;}
}
export async function finishDraftLettering({current,commit,ask,cancelled,notify,check,recognize}) {
  const ids=current().panels.map(p=>p.id);
  for(const id of ids) {
    if(cancelled())return;
    const p=current(),panel=p.panels.find(p=>p.id===id);
    if(!panel?.image || !panelHasText(panel) || panel.lettering)continue;
    notify(`${id} の文字を配置中`);
    const job={id:crypto.randomUUID(),kind:'draft_lettering',panelId:id,status:'running',source_revision:panel.snapshotId};
    await commit({...p,jobs:[...p.jobs,job]});
    const base=editBase(current());
    try {
      const visual=recognize?await recognize(current(),panel):null;
      const layout=await proposeLettering(current(),panel,'初稿の文字配置',ask,visual);
      if(cancelled()||base!==editBase(current()))throw Error('文字配置を停止しました。作画は保存済みです');
      const next=setLettering(current(),id,layout);
      if(check)await check(next,id);
      await commit({...next,jobs:next.jobs.map(j=>j.id===job.id?{...j,status:'complete'}:j)});
    }catch(e){await commit({...current(),jobs:current().jobs.map(j=>j.id===job.id?{...j,status:'failed'}:j)});throw e;}
  }
}
export async function reviewDraft(project,render) {
  const snapshot=project.snapshots.find(s=>s.id===project.active);
  if(!snapshot)throw Error('初稿の原作がありません');
  const scenes = draftScenes(project);
  if(project.panels.some(p=>!scenes.some(s=>s.id===p.sceneId)))throw Error('初稿の対象外のコマがあります');
  const warnings=layoutWarnings(project.layout,project.panels);
  if(warnings.length)throw Error(warnings.join(' / '));
  for(const scene of scenes) {
    const panels=project.panels.filter(p=>p.sceneId===scene.id);
    if(panels.some(p=>p.snapshotId!==snapshot.id) || JSON.stringify(panels.flatMap(p=>p.unitIds))!==JSON.stringify(sourceUnits(scene.id,scene.text).map(u=>u.id)))throw Error('初稿の原文参照・順序を確認してください');
  }
  const pages=[];
  for(const page of project.layout.pages) {
    const panels=pagePanels(project,page);
    if(panels.some(p=>!p.image||(panelHasText(p)&&!p.lettering)))throw Error('初稿の作画または必要な文字配置が未完了です');
    pages.push(await render(panels,project.snapshots,project.localizations,project.output_locale,page,false,project.layout.imageCrops));
  }
  if(!pages.length)throw Error('初稿ページがありません');
  return pages;
}
