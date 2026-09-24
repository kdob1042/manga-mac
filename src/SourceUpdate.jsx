import {isCloudImage,imageConnectionId} from './media.js';
import NameEditor from './NameEditor.jsx';
import {produceSourceCandidate} from './production.js';
import {generatePanel} from './pipeline.js';
import React,{useRef,useState,useEffect} from 'react';
import SourceManuscript from './SourceManuscript.jsx';
import {prepareSourceUpdate,commitSourceUpdate,rebaseExpected,refreshSourceCandidate} from './source-patch.js';
import {proposeSourceReplan,validateSourceCandidate} from './source-replan.js';
import {sourceRunGroups} from './source-runs.js';
import {createRangeScheduler} from './execution.js';
import {askLLM} from './llm.js';
import {call,desktop} from './bridge.js';
import {pagePNG} from './render.js';
import {pagePanels} from './layout.js';
const stages={waiting:'依存する範囲の完了待ち',planning:'更新案を計画中',candidate:'更新案を確認できます',drawing:'必要な作画を生成中',stopping:'現在の応答を回収して停止中',stopped:'停止済み・素材を保持',failed:'失敗・候補を保持',complete:'反映済み'};
// Keep selection and candidates mounted; hidden UI need not rebuild the source diff.
const SourceUpdateContent=React.memo(({children})=>children,(_previous,next)=>!next.active);
export default function SourceUpdate({project,current,commit,acceptSaved,exclusive=fn=>fn(),busy,model,imageModelId,active=true,sourceFocus=null}){
 const scheduler=useRef(createRangeScheduler()),controls=useRef(new Map()),[local,setLocal]=useState([]),[error,setError]=useState('');
 const redraw=()=>setLocal([...controls.current.values()].map(c=>({id:c.id,selection:c.selection,stage:c.stage,note:c.note,workId:c.workId})));
 const sameWork=id=>{if(current.current.workId!==id)throw Error('対象作品が変わりました');};
 useEffect(()=>()=>{for(const c of controls.current.values()){c.stopped=true;scheduler.current.release(c.id);}},[project.workId]);
 const patchJob=(id,workId,change)=>commit(p=>{if(p.workId!==workId)throw Error('対象作品が変わりました');return {...p,jobs:p.jobs.map(j=>j.id===id?change(j):j)};});
 async function stage(c,value){c.stage=value;redraw();await patchJob(c.id,c.workId,j=>({...j,run:{...j.run,stage:value}}));}
 async function nativePlan(c,prepared){return exclusive(async()=>{sameWork(c.workId);const p=current.current,expected=rebaseExpected(p,prepared),plan=await call('rebase_source_patch',{workId:p.workId,opId:c.id,baseContentToken:p.contentToken,expected});sameWork(c.workId);acceptSaved(JSON.parse(await call('load_project')));return {...prepared,expected,plan,identity:{...prepared.identity,baseContentToken:p.contentToken}};});}
 async function refresh(c,candidate){return exclusive(async()=>{sameWork(c.workId);const updated=await refreshSourceCandidate(current.current,candidate,call);sameWork(c.workId);acceptSaved(JSON.parse(await call('load_project')));return updated;});}
 async function proof(patch){
  const before=current.current,p={...before,...patch};
  const oldPages=new Map(before.layout.pages.map(page=>[page.id,JSON.stringify(page)]));
  const oldPanels=new Map(before.panels.map(panel=>[panel.id,JSON.stringify(panel)]));
  const changedPanels=new Set(p.panels.filter(panel=>JSON.stringify(panel)!==oldPanels.get(panel.id)).map(panel=>panel.id));
  const nextPanelIds=new Set(p.panels.map(panel=>panel.id));
  for(const id of oldPanels.keys())if(!nextPanelIds.has(id))changedPanels.add(id);
  for(const page of patch.layout.pages){
   if(JSON.stringify(page)===oldPages.get(page.id)&&!page.slots.some(slot=>changedPanels.has(slot.panelId)))continue;
   await pagePNG(pagePanels(p,page),p.snapshots,p.localizations,p.output_locale,page,true,p.layout.imageCrops);
  }
 }
 async function execute(c,selection){
  try{
   let prepared=await exclusive(async()=>{sameWork(c.workId);const p=current.current;const value=await prepareSourceUpdate(p,selection,call,c.id);sameWork(c.workId);acceptSaved(JSON.parse(await call('load_project')));return value;});
   await patchJob(c.id,c.workId,j=>({...j,run:{id:c.runId,groupId:c.id,stage:'waiting',keys:c.keys,selection:c.selection,connectionId:c.model.connectionId}}));
   await scheduler.current.acquire(c.id,c.keys,()=>c.stopped);c.acquired=true;
   prepared=await nativePlan(c,prepared);
   const input=structuredClone(current.current);
   await stage(c,'planning');
   let candidate=await proposeSourceReplan(input,prepared,(prompt,schema)=>askLLM(c.model,{purpose:'plan',prompt,schema,cancelled:()=>c.stopped,waiting:()=>{c.stage='waiting';redraw();},started:()=>{c.stage='planning';redraw();}}));
   sameWork(c.workId);candidate=await refresh(c,candidate);
   if(!candidate.redrawPanelIds.length)await proof(candidate.patch);
   await patchJob(c.id,c.workId,j=>({...j,status:'candidate',source_candidate:candidate,run:{...j.run,stage:c.stopped?'stopped':'candidate'}}));
   c.stage=c.stopped?'stopped':'candidate';redraw();
  }catch(e){c.stage=c.stopped?'stopped':'failed';if(current.current.workId===c.workId){setError(e.message??String(e));await patchJob(c.id,c.workId,j=>({...j,run:{...j.run,stage:c.stage,error:e.message??String(e)}})).catch(()=>{});}scheduler.current.release(c.id);c.acquired=false;redraw();}
  finally {if(c.stopped){scheduler.current.release(c.id);c.acquired=false;}}
 }
 function propose(selection){
  try{setError('');const groups=sourceRunGroups(current.current,selection),runId=crypto.randomUUID();
   const pending=[...controls.current.values()].filter(c=>c.workId===project.workId&&!['failed','stopped','complete'].includes(c.stage)).flatMap(c=>c.selection.selectedBlockIds);
   if(selection.selectedBlockIds.some(id=>pending.includes(id)))throw Error('選択範囲は実行中です。別の範囲を選択してください');
   for(const group of groups){if(current.current.jobs.filter(j=>j.kind==='sourcePatch'&&j.source_patch?.baseContentToken===current.current.contentToken&&JSON.stringify(j.source_patch.expected?.sourceEdits.map(e=>[e.oldUnitIds,e.newRefs]))===JSON.stringify(group.blocks.map(e=>[e.oldUnitIds,e.newRefs]))).length>=3)throw Error('同じ範囲・基準版の計画は3回までです。保存済みの候補を確認してください');const id=crypto.randomUUID(),c={id,runId,workId:project.workId,model:structuredClone(model),selection:group.selection,keys:group.keys,stopped:false,stage:'waiting'};controls.current.set(id,c);void execute(c,group.selection);}redraw();
  }catch(e){setError(e.message??String(e));}
 }
 function control(job){let c=controls.current.get(job.id);if(!c){c={id:job.id,runId:job.run?.id??job.id,workId:project.workId,selection:job.run?.selection??job.source_candidate?.prepared.selection??{selectedBlockIds:[]},keys:job.run?.keys??[],model:structuredClone(model),stopped:false,stage:job.run?.stage??'candidate'};controls.current.set(job.id,c);}return c;}
 async function operate(job,action){const c=control(job);if(c.operating)return;c.operating=true;c.stopped=false;setError('');try{if(!c.acquired){await stage(c,'waiting');await scheduler.current.acquire(c.id,c.keys,()=>c.stopped);c.acquired=true;}await action(c);}catch(e){setError(e.message??String(e));await stage(c,c.stopped?'stopped':'failed').catch(()=>{});scheduler.current.release(c.id);c.acquired=false;}finally{c.operating=false;redraw();}}
 async function draw(job,panelIds=null){return operate(job,async c=>{
  let candidate=await refresh(c,current.current.jobs.find(j=>j.id===c.id).source_candidate);
  if(!candidate.nameConfirmed)throw Error('作画前にネームを確定してください');
  await patchJob(c.id,c.workId,j=>({...j,source_candidate:candidate}));await stage(c,'drawing');
  await produceSourceCandidate({current:()=>current.current,commit,opId:c.id,generate:generatePanel,recover:jobId=>{const job=current.current.jobs.find(j=>j.id===jobId);return isCloudImage(job?.media)?call('recover_cloud_image',{jobId,connectionId:imageConnectionId(current.current,job.media.registry_id)}):call('recover_image',{jobId});},cancelled:()=>c.stopped,notify:note=>{c.note=note;redraw();},
   refresh:async()=>{sameWork(c.workId);const latest=current.current.jobs.find(j=>j.id===c.id).source_candidate;const refreshed=await refresh(c,latest);await patchJob(c.id,c.workId,j=>({...j,source_candidate:refreshed}));},
   imageModelId,panelIds});await stage(c,c.stopped?'stopped':'candidate');if(c.stopped){scheduler.current.release(c.id);c.acquired=false;}
 });}
 async function adopt(job){return operate(job,async c=>{
  const applied=await exclusive(async()=>{sameWork(c.workId);const saved=JSON.parse(await call('load_project'));sameWork(c.workId);acceptSaved(saved);return !!saved.sourcePatchReceipts?.[c.id];});
  if(applied){c.stage='complete';scheduler.current.release(c.id);c.acquired=false;return;}
  const candidate=await refresh(c,current.current.jobs.find(j=>j.id===c.id).source_candidate);validateSourceCandidate(current.current,candidate);await proof(candidate.patch);
  if(c.stopped)throw Error('原稿反映を停止しました');
  await exclusive(async()=>{sameWork(c.workId);const saved=await commitSourceUpdate(current.current,candidate.prepared,candidate.patch,call);sameWork(c.workId);acceptSaved(typeof saved==='string'?JSON.parse(saved):saved);});
  c.stage='complete';scheduler.current.release(c.id);c.acquired=false;
 });}
 async function stop(job){const c=control(job);c.stopped=true;const inFlight=['planning','drawing'].includes(c.stage);try{await stage(c,inFlight?'stopping':'stopped');}catch(e){setError(e.message??String(e));}if(!inFlight){scheduler.current.release(c.id);c.acquired=false;}scheduler.current.wake();}
 const jobs=project.jobs.filter(j=>j.kind==='sourcePatch'&&j.status!=='complete'&&j.status!=='cancelled'&&(j.run||j.source_candidate));
 const completed=project.jobs.filter(j=>j.kind==='sourcePatch'&&j.status==='complete'&&j.run);
 const pendingBlockIds=local.filter(c=>c.workId===project.workId&&!['failed','stopped','complete'].includes(c.stage)).flatMap(c=>c.selection.selectedBlockIds);
 return <SourceUpdateContent active={active}><SourceManuscript project={project} busy={busy} pendingBlockIds={pendingBlockIds} current={()=>current.current} onApply={desktop()?propose:undefined} sourceFocus={sourceFocus}/>
 {!!completed.length&&<details><summary>適用履歴（{completed.length}グループ）</summary><ul>{completed.map(j=><li key={j.id}>適用済み · {j.source_candidate?.reason??'選択した原稿'}</li>)}</ul></details>}
 {error&&<p role="alert">{error}</p>}{!!jobs.length&&<><p>独立した範囲は同時に計画できます。ローカル推論は1件ずつ実行し、混在する範囲は待機します。</p><button onClick={()=>jobs.forEach(job=>void stop(job))}>すべての原稿処理を停止</button></>}
 {jobs.map(job=>{const c=job.source_candidate,stageValue=local.find(x=>x.id===job.id)?.stage??job.run?.stage??'candidate',working=['waiting','planning','drawing','stopping'].includes(stageValue)&&controls.current.has(job.id);return <section key={job.id} aria-label="原稿反映の更新案" className="edit-candidate"><h3>原稿反映の更新案</h3><p>{stages[stageValue]??stageValue}</p>{local.find(x=>x.id===job.id)?.note&&<p>{local.find(x=>x.id===job.id).note}</p>}{c?<><p>{c.reason}</p><NameEditor project={project} candidate={c} busy={busy||working} model={model} onDraw={ids=>draw(job,ids)} onChange={value=>{if(current.current.jobs.some(j=>j.sourcePatchOp===job.id&&['running','unknown','candidate'].includes(j.status)))throw Error('未確定の作画を回収してからネームを編集してください');return patchJob(job.id,project.workId,j=>({...j,source_candidate:value}));}}/><p>変更後 {c.patch.panels.length}コマ・{c.patch.layout.pages.length}ページ / 新規作画 {c.redrawPanelIds.length}コマ</p>{!!c.redrawPanelIds.length&&<button disabled={busy||working||!c.nameConfirmed} onClick={()=>void draw(job)}>画像AIで不足分を作画・再開</button>}<button disabled={busy||working||!!c.redrawPanelIds.length} onClick={()=>void adopt(job)}>この更新案を適用</button></>:!working&&<p>計画は未確定です。現在の差分を選び、明示的に再計画してください。</p>}<button disabled={['stopped','stopping'].includes(stageValue)} onClick={()=>void stop(job)}>この範囲を停止</button><button disabled={working} onClick={()=>void operate(job,async control=>{await patchJob(job.id,control.workId,j=>({...j,status:'cancelled'}));scheduler.current.release(job.id);control.acquired=false;control.stage='stopped';})}>取り下げる</button></section>;})}</SourceUpdateContent>;
}
