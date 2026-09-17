import React, {useState} from 'react';
import {startDraft,restoreDraft} from './draft';
import {confirmThroughPage,confirmedPageIndex,moveConfirmationBeforePage} from './confirmation';

export default function DraftControls({project,current,commit,run,busy,onSwitch,onProduce}) {
  const snapshot=project.snapshots.find(s=>s.id===project.active);
  const [selection,setSelection]=useState(null),[separate,setSeparate]=useState(false);
  if(!snapshot)return null;
  const ids=selection??(project.draftScope?.snapshotId===project.active?project.draftScope.sceneIds:snapshot.scenes.map(s=>s.id));
  const saved=project.history.filter(h=>h.draftCheckpoint),confirmed=confirmedPageIndex(project);
  async function setBoundary(value){const n=Number(value);await commit(n<0?moveConfirmationBeforePage(current.current,0):confirmThroughPage(current.current,n));}
  return <div className="draft-controls">
    <details><summary>制作する場面・保存した原稿</summary>
      <fieldset disabled={busy}><legend>制作する場面</legend>{snapshot.scenes.map(scene=><label key={scene.id}><input type="checkbox" checked={ids.includes(scene.id)} onChange={e=>setSelection(e.target.checked?[...ids,scene.id]:ids.filter(id=>id!==scene.id))}/>{scene.id}</label>)}</fieldset>
      <label><input type="checkbox" disabled={busy} checked={separate} onChange={e=>setSeparate(e.target.checked)}/>既存原稿を残して別の初稿を作る</label>
      {saved.length>0&&<label>保存した原稿<select aria-label="保存した原稿" value="" disabled={busy} onChange={e=>{const id=e.target.value;if(id)run('原稿を切り替え',async()=>{await commit(restoreDraft(current.current,id));setSelection(null);setSeparate(false);onSwitch();});}}><option value="">原稿を選ぶ</option>{saved.map(h=><option key={h.id} value={h.id}>{h.label}（{h.panels.length}コマ）</option>)}</select></label>}
    </details>
    {project.layout?.pages?.length>0&&<div className="confirmation-boundary"><label>確定境界<select aria-label="ここまで確定" disabled={busy} value={confirmed} onChange={e=>run('確定境界を変更',()=>setBoundary(e.target.value))}><option value={-1}>未確定</option>{project.layout.pages.map((p,i)=><option key={p.id} value={i}>P{i+1}まで確定</option>)}</select></label><small>{confirmed>=0?`P1〜P${confirmed+1}はAI再計画・reflow・コマ割り編集から保護されます。全体AI提案はP${confirmed+2}以降だけを再計画します。`:'確定境界を設定すると、それより前のページを保持したまま後ろだけ再計画できます。'}</small></div>}
    <button className="primary full" disabled={busy||!ids.length} onClick={()=>run('制作を開始',async()=>{await commit(startDraft(current.current,ids,separate));setSeparate(false);onSwitch();await onProduce();})}>✧ 漫画にする</button>
  </div>;
}
