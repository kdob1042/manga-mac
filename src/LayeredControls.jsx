import React,{useState} from 'react';
import {call,desktop} from './bridge.js';
import {imageOf} from './canvas-image.js';
import {layeredModels} from './media.js';
import {layeredRequest,layersToBundle} from './layered.js';
import {operation} from './compositor.js';

export default function LayeredControls({project,panel,current,commit,run,busy}) {
 const [modelId,setModelId]=useState(layeredModels[0]?.id??''),[count,setCount]=useState(4);
 const job=project.jobs.find(j=>j.kind==='decompose'&&j.panelId===panel.id&&['running','unknown'].includes(j.status));
 const transfer=async(saved,receipt)=>{
   const bundle=await layersToBundle(saved,receipt);
   const state=await call('compositor_start',{sessionId:saved.id,bundle});
   // Let the user inspect layers immediately. The shared editor controls claim and snapshot the same document.
   await call('compositor_call',{sessionId:saved.id,request:operation(state,'handoff')});
   await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===saved.id?{...j,status:'running'}:j)});
 };
 return <details className="shot-controls"><summary>原画をレイヤーに分解</summary>
 <p>実モデルの品質・24GBでの性能は未検証です。Compositor連携版が必要です。原画を残して分解し、層数や順序から人物を自動確定しません。分解後は外部レイヤー編集で確認し、候補として保存してください。</p>
 <fieldset disabled={busy||!desktop()}>
 <label>分解モデル<select value={modelId} onChange={e=>setModelId(e.target.value)}>{layeredModels.map(m=><option key={m.id} value={m.id}>{m.display_name}</option>)}</select></label>
 <label>レイヤー数<input type="number" min="2" max="6" value={count} onChange={e=>setCount(Number(e.target.value))}/></label>
 <button disabled={!modelId||!!job} onClick={()=>run('分解モデルを明示準備',()=>call('prepare_media_engine',{modelId}))}>分解モデルを準備する</button>
 <button disabled={!panel.image||!modelId||!!job} onClick={()=>run('原画をレイヤーに分解',async()=>{
   const p=current.current, source=p.panels.find(item=>item.id===panel.id), image=await imageOf(source.image);
   const {job:next,request}=await layeredRequest(p,source,modelId,count,image.width,image.height);
   await commit({...p,jobs:[...p.jobs,next]});
   try{await transfer(next,await call('generate_layers',{request}));}
   catch(error){await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===next.id?{...j,status:'unknown'}:j)});throw error;}
 })}>原画を保持して分解する</button>
 {job&&<><button onClick={()=>run('保存済みレイヤーを回収',async()=>transfer(job,await call('recover_image',{jobId:job.id})))}>分解済みの層をCompositorへ渡す</button>
 <p>接続済みの場合は下の「外部レイヤー編集」で状態または未確定結果を照合してください。この操作は再推論しません。</p></>}
 </fieldset></details>;
}
