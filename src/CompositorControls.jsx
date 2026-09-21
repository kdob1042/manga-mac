import {imageHash} from './revisions.js';
import {textForRefs} from './source-refs.js';
import React,{useState,useEffect} from 'react';
import LayerColourControls from './LayerColourControls.jsx';
import {call,desktop} from './bridge.js';
import {imageOf} from './canvas-image.js';
import {beginCompositor,finishCompositor,rasterBundle,reconcileBindings,operation} from './compositor.js';

export default function CompositorControls({project,panel,current,commit,run,busy}) {
 const [useCapture,setUseCapture]=useState(false),[state,setState]=useState(null),[layer,setLayer]=useState(''),[x,setX]=useState(0),[y,setY]=useState(0);
 const job=project.jobs.find(j=>j.compositor&&['compositor','decompose','layer_edit'].includes(j.kind)&&j.panelId===panel.id&&['running','unknown'].includes(j.status));
 const sessionId=job?.compositor.session_id??job?.id;
 useEffect(()=>{const receive=e=>{if(e.detail.sessionId===sessionId)setState(e.detail.state);};window.addEventListener('compositor-state',receive);return()=>window.removeEventListener('compositor-state',receive);},[sessionId]);
 useEffect(()=>{const selected=state?.layers?.find(l=>l.id===layer);if(selected){setX(selected.x);setY(selected.y);}},[state,layer]);
 const observe=async value=>{
   const next=value.state??value;setState(next);
   if(job&&next.layers){const saved=current.current.jobs.find(j=>j.id===job.id),bindings=reconcileBindings(saved.compositor.bindings,next,current.current.characters);await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:j.kind==='layer_edit'&&!j.layer_edit_applied?j.status:'running',compositor:{...j.compositor,bindings}}:j)});}
 };
 const send=async(op,args={})=>{
   let result=await call('compositor_call',{sessionId:job.compositor.session_id??job.id,request:op==='state'||op==='recover'||op==='saved_snapshot'?{op}:operation(state,op,args)});
   if(op==='claim'){result=await call('compositor_call',{sessionId,request:operation(result.state??result,'snapshot')});}
   if(result.bundle){
     const p=current.current, saved=p.jobs.find(j=>j.id===job.id);
     const ready={...p,jobs:p.jobs.map(j=>j.id===job.id?{...j,status:'running'}:j)};
     await commit(await finishCompositor(ready,saved,result));setState(null);
   }else {
     if(result.candidate_layer&&job.kind==='layer_edit')await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,layer_edit_applied:true,compositor:{...j.compositor,bindings:{...j.compositor.bindings,[result.candidate_layer]:job.layer_edit.character_id}}}:j)});
     await observe(result);
   }
 };
 const selected=state?.layers?.find(l=>l.id===layer);
 return <details className="shot-controls"><summary>外部レイヤー編集（Compositor）</summary>
 <details><summary>このコマの原稿・参照</summary><pre className="source-text">{textForRefs(panel.sourceRefs??[],project.snapshots)}</pre><div className="characters">{project.characters.filter(c=>panel.characterIds.includes(c.id)).map(c=><figure key={c.id}><img src={c.image} alt={c.name}/><figcaption>{c.name}</figcaption></figure>)}</div></details><p>連携版CompositorとmacOS 26.5以降が必要です。向き・ポーズ変更は未対応です。局所色変更は人物対応の確認後に使えます。</p>
 <fieldset disabled={busy||!desktop()}>
 {!job&&panel.capture_revision&&<label><input type="checkbox" checked={useCapture} onChange={e=>setUseCapture(e.target.checked)}/>撮影原本をCompositorで編集（AI生成なし）</label>}
 {!job&&<button disabled={!panel.image&&!panel.capture_revision} onClick={()=>run('Compositorを接続',async()=>{
   const p=current.current, source=p.panels.find(item=>item.id===panel.id),capture=(useCapture||!source.image)?p.captures?.find(c=>c.id===source.capture_revision):null;
   const next=await beginCompositor(p,source,capture);
   let original=source.image,bundle=capture?null:source.compositor?.bundle;
   if(capture){const value=await call('blender_capture',{sessionId:capture.session_id,requestId:capture.request_id});original=value.preview;if(await imageHash(original)!==capture.image.hash)throw Error('撮影原本のhashが一致しません');}
   if(!bundle){const image=await imageOf(original), canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);bundle=rasterBundle(canvas.toDataURL('image/png'),image.width,image.height);}
   await commit({...p,jobs:[...p.jobs,next]});
   try{setState(await call('compositor_start',{sessionId:next.id,bundle}));}
   catch(error){await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===next.id?{...j,status:'unknown'}:j)});throw error;}
 })}>レイヤー編集を始める</button>}
 {job&&<><button onClick={()=>run('編集状態を取得',()=>send('state'))}>接続状態を再取得</button>
 <button onClick={()=>run('未確定の操作を照合',()=>send('recover'))}>未確定の結果を照合</button>
 <button onClick={()=>run('保存済みの編集候補を回収',()=>send('saved_snapshot'))}>保存済み候補を回収</button></>}
 {state&&job&&<><p role="status">{state.owner==='app'?'アプリが操作中':state.owner==='codex'?'Codexが操作中':'Compositorで直接調整中'} · 版 {state.revision}</p>
 <label>対象レイヤー<select value={layer} onChange={e=>{const l=state.layers.find(l=>l.id===e.target.value);setLayer(e.target.value);setX(l?.x??0);setY(l?.y??0);}}><option value="">レイヤーを選択</option>{state.layers.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
 {selected&&<><label>人物対応<select value={job.compositor.bindings[layer]??''} onChange={e=>run('人物対応を保存',()=>commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,compositor:{...j.compositor,bindings:{...j.compositor.bindings,[layer]:e.target.value}}}:j)}))}><option value="">未確認</option>{project.characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
 <label>X<input type="number" value={x} onChange={e=>setX(Number(e.target.value))}/></label><label>Y<input type="number" value={y} onChange={e=>setY(Number(e.target.value))}/></label>
 <button disabled={state.owner!=='app'} onClick={()=>run('配置を変更',()=>send('transform',{layer,x,y,width:selected.width,height:selected.height,rotation:selected.rotation,visible:selected.visible}))}>位置を変更</button></>}
 <LayerColourControls job={job} state={state} layer={layer} current={current} commit={commit} run={run} busy={busy} onState={setState}/>
 <button disabled={state.owner!=='app'} onClick={()=>run('直接調整へ引継ぎ',()=>send('handoff'))}>直接調整する</button>
 <button disabled={state.owner!=='app'} onClick={()=>run('Codexへ引継ぎ',()=>send('handoff',{to:'codex'}))}>Codexに渡す</button>
 {state.owner==='codex'&&<p>セッションID: <code>{sessionId}</code>。連携版の integrations/compositor/client.py から限定操作できます。</p>}
 <button disabled={state.owner==='app'} onClick={()=>run('アプリへ戻す',()=>send('claim'))}>アプリに戻す</button>
 <button disabled={state.owner!=='app'||(job.kind==='layer_edit'&&!job.layer_edit_applied)} onClick={()=>run('編集版と合成画像を候補に保存',()=>send('snapshot'))}>この版を候補に保存</button></>}
 </fieldset></details>;
}
