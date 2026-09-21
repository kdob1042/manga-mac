import React, {useState} from 'react';
import {startDraft,restoreDraft} from './draft';
import {importNamePlan, MAX_NAME_PLAN_BYTES} from './name-import.js';

export default function DraftControls({project,current,commit,run,busy,onSwitch,onProduce}) {
  const snapshot=project.snapshots.find(s=>s.id===project.active);
  const [selection,setSelection]=useState(null),[separate,setSeparate]=useState(false);
  if(!snapshot)return null;
  const ids=selection??(project.draftScope?.snapshotId===project.active?project.draftScope.sceneIds:snapshot.scenes.map(s=>s.id));
  const saved=project.history.filter(h=>h.draftCheckpoint);
  async function readName(file) {
    if (!file) return;
    await run('ネームを検査して取り込み', async () => {
      if (file.size > MAX_NAME_PLAN_BYTES) throw Error('ネームJSONは2MB以内で指定してください');
      const base=current.current;
      const next=await importNamePlan(base,await file.text());
      if (current.current!==base) throw Error('取り込み中に作品が変更されました。再度選択してください');
      await commit(next);
      setSelection(null);setSeparate(false);onSwitch();
    });
  }
  return <div className="draft-controls">
    <details><summary>制作する場面・保存した原稿</summary>
      <fieldset disabled={busy}><legend>制作する場面</legend>{snapshot.scenes.map(scene=><label key={scene.id}><input type="checkbox" checked={ids.includes(scene.id)} onChange={e=>setSelection(e.target.checked?[...ids,scene.id]:ids.filter(id=>id!==scene.id))}/>{scene.id}</label>)}</fieldset>
      <label><input type="checkbox" disabled={busy} checked={separate} onChange={e=>setSeparate(e.target.checked)}/>既存原稿を残して別の初稿を作る</label>
      {saved.length>0&&<label>保存した原稿<select aria-label="保存した原稿" value="" disabled={busy} onChange={e=>{const id=e.target.value;if(id)run('原稿を切り替え',async()=>{await commit(restoreDraft(current.current,id));setSelection(null);setSeparate(false);onSwitch();});}}><option value="">原稿を選ぶ</option>{saved.map(h=><option key={h.id} value={h.id}>{h.label}（{h.panels.length}コマ）</option>)}</select></label>}
      <label>ネームJSONを取り込む<input type="file" accept=".json,application/json" aria-label="ネームJSONを取り込む" disabled={busy||project.panels.length>0} onChange={e=>{const file=e.target.files?.[0];e.target.value='';readName(file);}}/></label>
      <small>原稿を照合して未作画のコマを保存します。既存コマは上書きしません。画像生成・外部送信は行いません。</small>
      {project.namePlan?.snapshotId===project.active&&project.namePlan?.draftId===project.draftScope?.id&&<p role="status">ネーム取込済み：{project.namePlan.title}（{project.layout?.pages.length??0}ページ・{project.panels.length}コマ）</p>}
    </details>
    <button className="primary full" disabled={busy||!ids.length} onClick={()=>run('制作を開始',async()=>{await commit(startDraft(current.current,ids,separate));setSeparate(false);onSwitch();await onProduce();})}>✧ 漫画にする</button>
  </div>;
}
