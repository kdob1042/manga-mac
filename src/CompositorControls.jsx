import React,{useState} from 'react';
import {call,desktop} from './bridge.js';
import {imageOf} from './canvas-image.js';
import {beginCompositor,finishCompositor,rasterBundle,reconcileBindings,operation} from './compositor.js';

export default function CompositorControls({project,panel,current,commit,run,busy}) {
 const [state,setState]=useState(null),[layer,setLayer]=useState(''),[x,setX]=useState(0),[y,setY]=useState(0);
 const job=project.jobs.find(j=>j.kind==='compositor'&&j.panelId===panel.id&&['running','unknown'].includes(j.status));
 const observe=async value=>{
   const next=value.state??value;setState(next);
   if(job&&next.layers){const bindings=reconcileBindings(job.compositor.bindings,next,current.current.characters);await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'running',compositor:{...j.compositor,bindings}}:j)});}
 };
 const send=async(op,args={})=>{
   const result=await call('compositor_call',{sessionId:job.id,request:op==='state'||op==='recover'||op==='saved_snapshot'?{op}:operation(state,op,args)});
   if(result.bundle){
     const p=current.current, saved=p.jobs.find(j=>j.id===job.id);
     const ready={...p,jobs:p.jobs.map(j=>j.id===job.id?{...j,status:'running'}:j)};
     await commit(await finishCompositor(ready,saved,result));setState(null);
   }else await observe(result);
 };
 const selected=state?.layers?.find(l=>l.id===layer);
 return <details className="shot-controls"><summary>外部レイヤー編集（Compositor）</summary>
 <p>連携版CompositorとmacOS 26.5以降が必要です。レイヤー分解・AI描き直しはまだ利用できません。</p>
 <fieldset disabled={busy||!desktop()}>
 {!job&&<button disabled={!panel.image} onClick={()=>run('Compositorを接続',async()=>{
   const p=current.current, source=p.panels.find(item=>item.id===panel.id), next=await beginCompositor(p,source);
   let bundle=source.compositor?.bundle;
   if(!bundle){const image=await imageOf(source.image), canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);bundle=rasterBundle(canvas.toDataURL('image/png'),image.width,image.height);}
   await commit({...p,jobs:[...p.jobs,next]});
   try{setState(await call('compositor_start',{sessionId:next.id,bundle}));}
   catch(error){await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===next.id?{...j,status:'unknown'}:j)});throw error;}
 })}>レイヤー編集を始める</button>}
 {job&&<><button onClick={()=>run('編集状態を取得',()=>send('state'))}>接続状態を再取得</button>
 <button onClick={()=>run('未確定の操作を照合',()=>send('recover'))}>未確定の結果を照合</button>
 <button onClick={()=>run('保存済みの編集候補を回収',()=>send('saved_snapshot'))}>保存済み候補を回収</button></>}
 {state&&job&&<><p role="status">{state.owner==='app'?'アプリが操作中':'Compositorで直接調整中'} · 版 {state.revision}</p>
 <label>対象レイヤー<select value={layer} onChange={e=>{const l=state.layers.find(l=>l.id===e.target.value);setLayer(e.target.value);setX(l?.x??0);setY(l?.y??0);}}><option value="">レイヤーを選択</option>{state.layers.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
 {selected&&<><label>人物対応<select value={job.compositor.bindings[layer]??''} onChange={e=>run('人物対応を保存',()=>commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,compositor:{...j.compositor,bindings:{...j.compositor.bindings,[layer]:e.target.value}}}:j)}))}><option value="">未確認</option>{project.characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
 <label>X<input type="number" value={x} onChange={e=>setX(Number(e.target.value))}/></label><label>Y<input type="number" value={y} onChange={e=>setY(Number(e.target.value))}/></label>
 <button disabled={state.owner!=='app'} onClick={()=>run('配置を変更',()=>send('transform',{layer,x,y,width:selected.width,height:selected.height,rotation:selected.rotation,visible:selected.visible}))}>位置を変更</button></>}
 <button disabled={state.owner!=='app'} onClick={()=>run('直接調整へ引継ぎ',()=>send('handoff'))}>直接調整する</button>
 <button disabled={state.owner!=='human'} onClick={()=>run('アプリへ戻す',()=>send('claim'))}>アプリに戻す</button>
 <button disabled={state.owner!=='app'} onClick={()=>run('編集版と合成画像を候補に保存',()=>send('snapshot'))}>この版を候補に保存</button></>}
 </fieldset></details>;
}
