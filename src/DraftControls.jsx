import React, {lazy,Suspense,useState} from 'react';
import {startDraft,restoreDraft} from './draft';
const NamePlanControls=lazy(()=>import('./NamePlanControls.jsx'));

export default function DraftControls({project,current,commit,run,busy,onSwitch,onProduce,model,cancelled,canProduce=true,sourceToken='',episodeId=''}) {
  const snapshot=project.snapshots.find(s=>s.id===project.active);
  const [selection,setSelection]=useState(null),[separate,setSeparate]=useState(false),[nameOpened,setNameOpened]=useState(false);
  if(!snapshot)return null;
  const ids=selection??(project.draftScope?.snapshotId===project.active?project.draftScope.sceneIds:snapshot.scenes.map(s=>s.id));
  const selectedIds=new Set(ids),allSelected=ids.length===snapshot.scenes.length;
  const saved=project.history.filter(h=>h.draftCheckpoint);
  return <div className="draft-controls">
    <details onToggle={e=>{if(e.currentTarget.open)setNameOpened(true);}}><summary>制作する場面・保存した原稿</summary>
      <fieldset disabled={busy}><legend>制作する場面</legend>
        {snapshot.scenes.length>1&&<label><input type="checkbox" checked={allSelected} ref={node=>{if(node)node.indeterminate=ids.length>0&&!allSelected;}} onChange={e=>setSelection(e.target.checked?snapshot.scenes.map(s=>s.id):[])}/>すべての場面（{ids.length}/{snapshot.scenes.length}）</label>}
        {snapshot.scenes.map(scene=><label key={scene.id}><input type="checkbox" aria-label={scene.id} checked={selectedIds.has(scene.id)} onChange={e=>setSelection(e.target.checked?snapshot.scenes.filter(s=>s.id===scene.id||selectedIds.has(s.id)).map(s=>s.id):ids.filter(id=>id!==scene.id))}/>{scene.title?`${scene.title} · ${scene.id}`:scene.id}</label>)}
      </fieldset>
      <label><input type="checkbox" disabled={busy} checked={separate} onChange={e=>setSeparate(e.target.checked)}/>既存原稿を残して別の初稿を作る</label>
      {saved.length>0&&<label>保存した原稿<select aria-label="保存した原稿" value="" disabled={busy} onChange={e=>{const id=e.target.value;if(id)run('原稿を切り替え',async()=>{await commit(restoreDraft(current.current,id));setSelection(null);setSeparate(false);onSwitch();});}}><option value="">原稿を選ぶ</option>{saved.map(h=><option key={h.id} value={h.id}>{h.label}（{h.panels.length}コマ）</option>)}</select></label>}
      {nameOpened&&<Suspense fallback={<p role="status">ネーム編集を読み込み中…</p>}><NamePlanControls project={project} current={current} commit={commit} run={run} busy={busy} model={model} sceneIds={ids} onSwitch={()=>{setSelection(null);setSeparate(false);onSwitch();}} cancelled={cancelled} sourceToken={sourceToken} episodeId={episodeId}/></Suspense>}
    </details>
    <button className="primary full" disabled={busy||!canProduce||!ids.length||project.namePlan?.status==='stale'} onClick={()=>run('制作を開始',async()=>{if(current.current.namePlan?.format!=='manga-mac/name-plan/v2'||separate)await commit(startDraft(current.current,ids,separate));setSeparate(false);onSwitch();await onProduce();})}>{project.namePlan?.format==='manga-mac/name-plan/v2'&&!separate?'このネームで制作':'✧ 漫画にする'}</button>
  </div>;
}
