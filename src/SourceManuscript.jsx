import {sectionStatus} from './section-completion.js';
import React,{useEffect,useMemo,useState} from 'react';
import {sourceView,toggleSourceGroup,sourceSelection} from './source-view.js';
import {tagOptions,matchingScenes,rowSceneIds,tagBlockSelection,sceneTags} from './source-tags.js';
import './source-view.css';
export default function SourceManuscript({project,busy=false,onApply,current,pendingBlockIds=[],sourceFocus=null}){
 const [replanApplied,setReplanApplied]=useState(false);
 const [selection,setSelection]=useState({id:null,ids:[]}),[error,setError]=useState('');
 const [tags,setTags]=useState([]),[mode,setMode]=useState('any'),[expansion,setExpansion]=useState(null);
 const manuscriptRoot=React.useRef(null),pendingFocus=React.useRef(null);
 const view=useMemo(()=>{if(!project.active)return null;try{return sourceView(project,replanApplied);}catch(e){return {error:e.message};}},[project,replanApplied]);
 useEffect(()=>{setSelection({id:null,ids:[]});setError('');setExpansion(null);},[view?.changes?.id,project.workId,replanApplied]);
 useEffect(()=>{setTags([]);setExpansion(null);},[project.active,project.workId]);
 useEffect(()=>{if(sourceFocus?.id){pendingFocus.current=sourceFocus.id;setTags([]);}},[sourceFocus?.serial]);
 useEffect(()=>{
  const id=pendingFocus.current;
  if(!id)return;
  const target=[...(manuscriptRoot.current?.querySelectorAll('[data-source-scenes]')??[])].find(node=>JSON.parse(node.dataset.sourceScenes).includes(id));
  if(target){pendingFocus.current=null;target.scrollIntoView({block:'start'});target.focus({preventScroll:true});}
 },[sourceFocus?.serial,tags,view?.changes?.id]);
 const snapshot=project.snapshots.find(s=>s.id===project.active);
 if(!snapshot)return <section aria-label="原稿"><h2>原稿</h2><p>GitHubから原稿を取り込むとここで確認できます。</p></section>;
 if(view?.error)return <section ref={manuscriptRoot} aria-label="原稿"><h2>原稿</h2><p role="status">原稿と漫画の対応を確認できないため、現在は本文のみ表示しています。</p>{snapshot.scenes.map(scene=><section tabIndex={-1} data-source-scenes={JSON.stringify([scene.id])} key={scene.id}><h3>{scene.id}</h3><pre className="source-text">{scene.text}</pre></section>)}</section>;
 const {changes,rows:allRows,resolve}=view,ids=selection.id===changes.id?selection.ids:[];
 const options=tagOptions(snapshot),sceneIds=matchingScenes(snapshot,tags,mode);
 const rows=tags.length?allRows.filter(row=>rowSceneIds(row).some(id=>sceneIds.includes(id))):allRows;
 const filterChange=next=>{setTags(next);setSelection({id:changes.id,ids:[]});setExpansion(null);};
 const selectMatches=()=>{const next=tagBlockSelection(changes,allRows,sceneIds,pendingBlockIds);if(next.additional.length)setExpansion(next);else setSelection({id:changes.id,ids:next.ids});};
 const toggle=id=>{setError('');const group=changes.blocks.find(b=>b.id===id)?.groupId;if(changes.blocks.some(b=>b.groupId===group&&pendingBlockIds.includes(b.id))){setError('関連する差分が実行中です');return;}setSelection({id:changes.id,ids:toggleSourceGroup(changes,ids,id)});};
 const parts=list=>list.map(({ref,changed},i)=><React.Fragment key={i}>{i>0&&!(list[i-1].ref.snapshotId===ref.snapshotId&&list[i-1].ref.sceneId===ref.sceneId&&list[i-1].ref.endCp===ref.startCp)&&'\n\n'}{changed?<mark>{resolve(ref)}</mark>:resolve(ref)}</React.Fragment>);
 const oldText=refs=>refs.map(resolve).join('\n\n');
 async function apply(){try{setError('');const latest=current?.()??project;await onApply(sourceSelection(latest,changes,ids));setSelection({id:changes.id,ids:[]});}catch(e){setError(e.message);}}
 return <section ref={manuscriptRoot} className="source-manuscript" aria-label="原稿"><h2>原稿</h2><p>青：未着手・未反映 / 通常：制作中 / 緑：完了 / 黄：要確認 / 赤：削除対象</p><p>原稿 {snapshot.sha?.slice(0,8)??snapshot.id} · 読み取り専用。漫画への反映状態を表示しています。</p>
  <button aria-pressed={replanApplied} onClick={()=>setReplanApplied(!replanApplied)}>反映済み原稿も選んでネームを再計画</button>
  {!!options.length&&<fieldset><legend>シーンタグで検索</legend>{options.map(tag=><label key={tag.key}><input type="checkbox" checked={tags.includes(tag.key)} onChange={()=>filterChange(tags.includes(tag.key)?tags.filter(k=>k!==tag.key):[...tags,tag.key])}/>{tag.label}</label>)}<label>タグの一致条件<select value={mode} onChange={e=>{setMode(e.target.value);filterChange(tags);}}><option value="any">いずれかに一致</option><option value="all">すべてに一致</option></select></label><button onClick={()=>filterChange([])}>絞り込みを解除</button><p>{sceneIds.length} シーン: {sceneIds.join(' / ')}</p><button disabled={busy} onClick={selectMatches}>該当シーンをまとめて選択</button><p>タグは原稿リポジトリの manifest.json の scenes[].tags で編集し、「GitHub側の更新を確認」から取り込みます。転送範囲には影響しません。</p></fieldset>}
  {!!options.length&&<ul aria-label="シーン別タグ">{snapshot.scenes.filter(scene=>sceneIds.includes(scene.id)).map(scene=><li key={scene.id}>{scene.id}: {sceneTags(snapshot,scene.id).join(' / ')||'タグなし'}</li>)}</ul>}
  {expansion&&<div role="alert">関連差分のため追加対象が必要です: {expansion.additional.join(' / ')}<button disabled={busy} onClick={()=>{const latest=tagBlockSelection(changes,allRows,sceneIds,pendingBlockIds);setSelection({id:changes.id,ids:latest.ids});setExpansion(null);}}>追加対象を含めて選択</button><button onClick={()=>setExpansion(null)}>取消</button></div>}
  <div className="toolbar"><button disabled={busy||!changes.blocks.length} onClick={()=>setSelection({id:changes.id,ids:changes.blocks.filter(b=>!pendingBlockIds.includes(b.id)).map(b=>b.id)})}>未反映・削除対象をすべて選択</button><button disabled={busy||!ids.length} onClick={()=>setSelection({id:changes.id,ids:[]})}>全解除</button><span role="status">{ids.length} / {changes.blocks.length} ブロックを選択</span><button disabled={busy||!ids.length||!onApply} onClick={apply}>選択箇所を漫画に反映</button></div>
  {!onApply&&<p>差分の確認・選択ができます。漫画への反映は準備中です。</p>}{error&&<p role="alert">{error}</p>}
  {!rows.length&&<p>本文はありません。</p>}
  {rows.map((row,i)=>row.type==='applied'?<article tabIndex={-1} data-source-scenes={JSON.stringify(rowSceneIds(row))} className={`source-applied ${sectionStatus(project,row.ref.sceneId)==='完了'?'section-complete':sectionStatus(project,row.ref.sceneId)==='要確認'?'section-review':''}`} key={`applied:${i}`}><strong>{sectionStatus(project,row.ref.sceneId)} · 反映済み · {row.ref.sceneId}</strong><pre className="source-text">{resolve(row.ref)}</pre></article>:row.type==='move-origin'?<aside tabIndex={-1} data-source-scenes={JSON.stringify(rowSceneIds(row))} key={`origin:${row.block.id}`} className="source-deletion"><strong>削除対象 · 移動元</strong><p>移動先と同時に反映します。</p><pre className="source-text">{oldText(row.oldRefs)}</pre><button disabled={busy||pendingBlockIds.includes(row.block.id)} aria-pressed={ids.includes(row.block.id)} onClick={()=>toggle(row.block.id)}>移動元・移動先をまとめて{ids.includes(row.block.id)?'解除':'選択'}</button></aside>:<article tabIndex={-1} data-source-scenes={JSON.stringify(rowSceneIds(row))} key={row.block.id} className="source-change">
   <label className="source-select"><input type="checkbox" disabled={busy||pendingBlockIds.includes(row.block.id)} checked={ids.includes(row.block.id)} onChange={()=>toggle(row.block.id)}/>{row.block.replan?'反映済み · 再計画':row.block.kind==='delete'?'削除対象':row.block.kind==='replace'?'未反映 · 変更':row.block.kind==='move'?'未反映 · 移動':'未反映 · 追加'} · {[...new Set([...row.oldRefs,...row.block.newRefs].map(r=>r.sceneId))].join(' / ')}</label>{pendingBlockIds.includes(row.block.id)&&<p>この範囲は実行中です。</p>}
   {row.block.diagnostic&&<p>{row.block.diagnostic==='ambiguous_alignment'?'同じ文章が複数あるため、旧文と新文をまとめて確認してください。':'変更が大きいため、広い範囲をまとめて確認してください。'}</p>}
   {!!row.oldRefs.length&&!row.block.replan&&<div className="source-deletion"><strong>削除対象 · 旧文{row.block.kind==='move'?'（移動元）':''}</strong><pre className="source-text">{parts(row.highlight.old)}</pre></div>}
   {!!row.block.newRefs.length&&<div className="source-addition"><strong>{row.block.replan?'再計画する原文':'未反映 · 新文'}{row.block.kind==='move'?'（移動先）':''}</strong><pre className="source-text">{parts(row.highlight.new)}</pre></div>}
  </article>)}
 </section>;
}
