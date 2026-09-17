import {produceSourceCandidate} from './production.js';
import {generatePanel} from './pipeline.js';
import React from 'react';
import SourceManuscript from './SourceManuscript.jsx';
import {prepareSourceUpdate,commitSourceUpdate} from './source-patch.js';
import {proposeSourceReplan,validateSourceCandidate} from './source-replan.js';
import {askLLM} from './llm.js';
import {call,desktop} from './bridge.js';
import {pagePNG} from './render.js';
import {pagePanels} from './layout.js';
export default function SourceUpdate({project,current,commit,acceptSaved,run,busy,model,cancelled}){
 const candidates=project.jobs.filter(j=>j.kind==='sourcePatch'&&j.status==='candidate'&&j.source_candidate);
 const sameWork=id=>{if(current.current.workId!==id)throw Error('対象作品が変わりました');};
 async function propose(selection){
  const p=current.current;
  if(p.jobs.filter(j=>j.kind==='sourcePatch'&&j.source_patch?.baseContentToken===p.contentToken).length>=3)throw Error('同じ基準版の更新案は3回までです。保存済みの候補を確認してください');
  const prepared=await prepareSourceUpdate(p,selection,call);
  // Reload authoritative Job before saving candidate metadata.
  sameWork(p.workId);acceptSaved(JSON.parse(await call('load_project')));
  const candidate=await proposeSourceReplan(p,prepared,(prompt,schema)=>askLLM(model,{purpose:'plan',prompt,schema}));
  sameWork(p.workId);if(cancelled())throw Error('原稿反映の計画を停止しました');
  if(current.current.contentToken!==prepared.identity.baseContentToken)throw Error('計画中に作品が変わりました');
  if(!candidate.redrawPanelIds.length)await proof(candidate.patch);
  await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===prepared.identity.opId?{...j,status:'candidate',source_candidate:candidate}:j)});
 }
 async function proof(patch){const p={...current.current,...patch};for(const page of patch.layout.pages.filter(page=>JSON.stringify(page)!==JSON.stringify(current.current.layout.pages.find(old=>old.id===page.id))||page.slots.some(s=>JSON.stringify(p.panels.find(panel=>panel.id===s.panelId))!==JSON.stringify(current.current.panels.find(panel=>panel.id===s.panelId)))))await pagePNG(pagePanels(p,page),p.snapshots,p.localizations,p.output_locale,page,true,p.layout.imageCrops);}
 async function adopt(candidate){
  const p=current.current;validateSourceCandidate(p,candidate);await proof(candidate.patch);
  if(cancelled())throw Error('原稿反映を停止しました');sameWork(p.workId);
  const saved=await commitSourceUpdate(current.current,candidate.prepared,candidate.patch,call);
  // Native already committed project + application + Undo + receipt atomically.
  sameWork(p.workId);acceptSaved(typeof saved==='string'?JSON.parse(saved):saved);
 }
 return <><SourceManuscript project={project} busy={busy} current={()=>current.current} onApply={desktop()?selection=>run('選択した原稿の更新案を作成',()=>propose(selection)):undefined}/>
 {candidates.map(job=>{const c=job.source_candidate,stale=c.prepared.identity.baseContentToken!==project.contentToken;return <section key={job.id} aria-label="原稿反映の更新案" className="edit-candidate"><h3>原稿反映の更新案</h3><p>{c.reason}</p><p>変更後 {c.patch.panels.length}コマ・{c.patch.layout.pages.length}ページ / 新規作画 {c.redrawPanelIds.length}コマ</p>{stale&&<p>作品が変わったため、現在の差分から再計画してください。</p>}{!!c.redrawPanelIds.length&&<><p>必要なコマだけを作画し、揃ってから更新案を適用します。</p><button disabled={busy||stale} onClick={()=>run('必要な作画を生成',()=>produceSourceCandidate({current:()=>current.current,commit,opId:job.id,generate:generatePanel,recover:jobId=>call('recover_image',{jobId}),cancelled}))}>画像AIで不足分を作画・再開</button></>}<button disabled={busy||stale||!!c.redrawPanelIds.length} onClick={()=>run('原稿反映を保存',()=>adopt(c))}>この更新案を適用</button><button disabled={busy} onClick={()=>run('更新案を取り下げ',()=>commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'cancelled'}:j)}))}>取り下げる</button></section>;})}</>;
}
