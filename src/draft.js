import { proposeLayout, adoptLayoutProposal } from './layout-ai.js';
import { proposeLettering } from './lettering-ai.js';
import { setLettering } from './lettering.js';
import { sourceUnits } from './core.js';
import { editBase } from './edit-commands.js';
import { pagePanels } from './layout.js';
// Sequential domain stages persisted in the existing jobs. Image jobs stay authoritative.
export async function prepareDraftLayout({current,commit,ask,cancelled}) {
  const p=current(),scope=p.layout.pages.map(pg=>pg.id);
  if(!scope.length || p.panels.some(p=>p.image) || p.layoutHistory?.length || p.jobs.some(j=>j.kind==='draft_layout'&&j.status==='complete'&&j.source_revision===p.active))return;
  const job={id:crypto.randomUUID(),kind:'draft_layout',status:'running',source_revision:p.active};
  await commit({...p,jobs:[...p.jobs,job]});
  const base=editBase(current());
  try {
    const candidate=await proposeLayout(current(),scope,'初稿。文字量と演出に合わせてページを構成してください',ask);
    if(cancelled()||base!==editBase(current()))throw Error('初稿の配置を停止しました。保存済みの内容は保持しています');
    const next=adoptLayoutProposal(current(),candidate);
    await commit({...next,jobs:next.jobs.map(j=>j.id===job.id?{...j,status:'complete'}:j)});
  }catch(e){await commit({...current(),jobs:current().jobs.map(j=>j.id===job.id?{...j,status:'failed'}:j)});throw e;}
}
export async function finishDraftLettering({current,commit,ask,cancelled,notify,check}) {
  const ids=current().panels.map(p=>p.id);
  for(const id of ids) {
    if(cancelled())return;
    const p=current(),panel=p.panels.find(p=>p.id===id);
    if(!panel?.image || panel.lettering)continue;
    notify(`${id} の文字を配置中`);
    const job={id:crypto.randomUUID(),kind:'draft_lettering',panelId:id,status:'running',source_revision:panel.snapshotId};
    await commit({...p,jobs:[...p.jobs,job]});
    const base=editBase(current());
    try {
      const layout=await proposeLettering(current(),panel,'初稿の文字配置',ask);
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
  for(const scene of snapshot.scenes) {
    const panels=project.panels.filter(p=>p.sceneId===scene.id);
    if(panels.some(p=>p.snapshotId!==snapshot.id) || JSON.stringify(panels.flatMap(p=>p.unitIds))!==JSON.stringify(sourceUnits(scene.id,scene.text).map(u=>u.id)))throw Error('初稿の原文参照・順序を確認してください');
  }
  const pages=[];
  for(const page of project.layout.pages) {
    const panels=pagePanels(project,page);
    if(panels.some(p=>!p.image||!p.lettering))throw Error('初稿の作画または文字配置が未完了です');
    pages.push(await render(panels,project.snapshots,project.localizations,project.output_locale,page,false,project.layout.imageCrops));
  }
  if(!pages.length)throw Error('初稿ページがありません');
  return pages;
}
