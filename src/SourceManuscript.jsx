import React,{useEffect,useMemo,useState} from 'react';
import {sourceView,toggleSourceGroup,sourceSelection} from './source-view.js';
import './source-view.css';
export default function SourceManuscript({project,busy=false,onApply,current,pendingBlockIds=[]}){
 const [selection,setSelection]=useState({id:null,ids:[]}),[error,setError]=useState('');
 const view=useMemo(()=>{if(!project.active)return null;try{return sourceView(project);}catch(e){return {error:e.message};}},[project]);
 useEffect(()=>{setSelection({id:null,ids:[]});setError('');},[view?.changes?.id,project.workId]);
 const snapshot=project.snapshots.find(s=>s.id===project.active);
 if(!snapshot)return <section aria-label="原稿"><h2>原稿</h2><p>GitHubから原稿を取り込むとここで確認できます。</p></section>;
 if(view?.error)return <section aria-label="原稿"><h2>原稿</h2><p role="status">原稿と漫画の対応を確認できないため、現在は本文のみ表示しています。</p>{snapshot.scenes.map(scene=><section key={scene.id}><h3>{scene.id}</h3><pre className="source-text">{scene.text}</pre></section>)}</section>;
 const {changes,rows,resolve}=view,ids=selection.id===changes.id?selection.ids:[];
 const toggle=id=>{setError('');setSelection({id:changes.id,ids:toggleSourceGroup(changes,ids,id)});};
 const parts=list=>list.map(({ref,changed},i)=><React.Fragment key={i}>{i>0&&!(list[i-1].ref.snapshotId===ref.snapshotId&&list[i-1].ref.sceneId===ref.sceneId&&list[i-1].ref.endCp===ref.startCp)&&'\n\n'}{changed?<mark>{resolve(ref)}</mark>:resolve(ref)}</React.Fragment>);
 const oldText=refs=>refs.map(resolve).join('\n\n');
 async function apply(){try{setError('');const latest=current?.()??project;await onApply(sourceSelection(latest,changes,ids));setSelection({id:changes.id,ids:[]});}catch(e){setError(e.message);}}
 return <section className="source-manuscript" aria-label="原稿"><h2>原稿</h2><p>原稿 {snapshot.sha?.slice(0,8)??snapshot.id} · 読み取り専用。漫画への反映状態を表示しています。</p>
  <div className="toolbar"><button disabled={busy||!changes.blocks.length} onClick={()=>setSelection({id:changes.id,ids:changes.blocks.filter(b=>!pendingBlockIds.includes(b.id)).map(b=>b.id)})}>未反映・削除対象をすべて選択</button><button disabled={busy||!ids.length} onClick={()=>setSelection({id:changes.id,ids:[]})}>全解除</button><span role="status">{ids.length} / {changes.blocks.length} ブロックを選択</span><button disabled={busy||!ids.length||!onApply} onClick={apply}>選択箇所を漫画に反映</button></div>
  {!onApply&&<p>差分の確認・選択ができます。漫画への反映は準備中です。</p>}{error&&<p role="alert">{error}</p>}
  {!rows.length&&<p>本文はありません。</p>}
  {rows.map((row,i)=>row.type==='applied'?<article className="source-applied" key={`applied:${i}`}><strong>反映済み · {row.ref.sceneId}</strong><pre className="source-text">{resolve(row.ref)}</pre></article>:row.type==='move-origin'?<aside key={`origin:${row.block.id}`} className="source-deletion"><strong>削除対象 · 移動元</strong><p>移動先と同時に反映します。</p><pre className="source-text">{oldText(row.oldRefs)}</pre><button disabled={busy||pendingBlockIds.includes(row.block.id)} aria-pressed={ids.includes(row.block.id)} onClick={()=>toggle(row.block.id)}>移動元・移動先をまとめて{ids.includes(row.block.id)?'解除':'選択'}</button></aside>:<article key={row.block.id} className="source-change">
   <label className="source-select"><input type="checkbox" disabled={busy||pendingBlockIds.includes(row.block.id)} checked={ids.includes(row.block.id)} onChange={()=>toggle(row.block.id)}/>{row.block.kind==='delete'?'削除対象':row.block.kind==='replace'?'未反映 · 変更':row.block.kind==='move'?'未反映 · 移動':'未反映 · 追加'} · {[...new Set([...row.oldRefs,...row.block.newRefs].map(r=>r.sceneId))].join(' / ')}</label>{pendingBlockIds.includes(row.block.id)&&<p>この範囲は実行中です。</p>}
   {row.block.diagnostic&&<p>{row.block.diagnostic==='ambiguous_alignment'?'同じ文章が複数あるため、旧文と新文をまとめて確認してください。':'変更が大きいため、広い範囲をまとめて確認してください。'}</p>}
   {!!row.oldRefs.length&&<div className="source-deletion"><strong>削除対象 · 旧文{row.block.kind==='move'?'（移動元）':''}</strong><pre className="source-text">{parts(row.highlight.old)}</pre></div>}
   {!!row.block.newRefs.length&&<div className="source-addition"><strong>未反映 · 新文{row.block.kind==='move'?'（移動先）':''}</strong><pre className="source-text">{parts(row.highlight.new)}</pre></div>}
  </article>)}
 </section>;
}
