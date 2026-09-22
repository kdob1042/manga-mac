import React,{useState} from 'react';
import {call} from './bridge.js';
import {executeImage} from './media-runtime.js';
import {adoptCandidate} from './revisions.js';
import {finishCompositor,operation} from './compositor.js';
import {colourRequest,completeColourEdit} from './layer-edit.js';

export default function LayerColourControls({job,state,layer,current,commit,run,busy,onState}) {
 const [colour,setColour]=useState('#3366cc'),[rect,setRect]=useState([0,0,1,1]);
 const sessionId=job.compositor.session_id??job.id;
 const collect=async(saved,receipt)=>{
   const image=await completeColourEdit(saved,receipt);
   await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===saved.id?{...j,layer_edit_result:{image}}:j)});
   let latest=await call('compositor_call',{sessionId,request:{op:'state'}}),base=saved.layer_edit.source;
   if(['instance','document','revision'].some(k=>latest[k]!==base[k])||latest.owner==='codex')throw Error('編集先の版が変わりました。生成結果は保存済みですが自動取込みしません');
   if(latest.owner==='human')latest=await call('compositor_call',{sessionId,request:operation(latest,'claim')});
   const result=await call('compositor_call',{sessionId,request:operation(latest,'import_candidate',{layer:base.layer,image})});
   await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===saved.id?{...j,status:'running',layer_edit_applied:true,compositor:{...j.compositor,bindings:{...j.compositor.bindings,[result.candidate_layer]:saved.layer_edit.character_id}}}:j)});
   onState(result.state);
 };
 return <details><summary>参照付きの局所色変更（輪郭固定）</summary><p>実推論・人物一貫性は未検証です。透明度と範囲外の画素を保持します。向き・ポーズ変更には対応しません。</p>
 {job.kind!=='layer_edit'?<fieldset disabled={busy||state.owner!=='app'||!layer||!job.compositor.bindings[layer]}>
 <label>色<input type="color" value={colour} onChange={e=>setColour(e.target.value)}/></label>
 {['左','上','幅','高さ'].map((label,i)=><label key={label}>{label}（0〜1）<input type="number" min="0" max="1" step="0.05" value={rect[i]} onChange={e=>setRect(rect.map((n,k)=>k===i?Number(e.target.value):n))}/></label>)}
 <button onClick={()=>run('参照付きで局所色変更',async()=>{
   // Freeze the current editing version as a candidate first; it remains unadopted.
   const snapshot=await call('compositor_call',{sessionId,request:operation(state,'snapshot')});
   await commit(await finishCompositor(current.current,job,snapshot));
   // Reuse the pure adoption check to reject an old editor source; do not adopt its returned project.
   await adoptCandidate(current.current,job.id);
   let nextState=await call('compositor_call',{sessionId,request:{op:'state'}});
   nextState=await call('compositor_call',{sessionId,request:operation(nextState,'claim')});
   const capture=await call('compositor_call',{sessionId,request:operation(nextState,'capture_layer',{layer})});
   const p=current.current,panel=p.panels.find(p=>p.id===job.panelId),modelId=p.mediaDefaults.image;
   let next,request;
   try{({job:next,request}=await colourRequest(p,panel,sessionId,capture,job.compositor.bindings[layer],rect,colour,modelId));}
   catch(error){await call('compositor_call',{sessionId,request:operation(capture.state,'handoff')});throw error;}
   next.compositor.bindings={...job.compositor.bindings};
   await commit({...p,jobs:[...p.jobs,next]});
   try{await executeImage(next.media.registry_id,request);await collect(next,await call('recover_image',{jobId:next.id}));}
   catch(error){await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===next.id?{...j,status:'unknown'}:j)});throw error;}
 })}>範囲内の色を候補として変更</button></fieldset>:<>
 {!job.layer_edit_applied&&<button disabled={busy} onClick={()=>run('レイヤー編集結果を照合',async()=>collect(job,await call('recover_image',{jobId:job.id})))}>保存済みの色変更を回収</button>}
 {job.layer_edit_result?.image&&<img className="shot-preview" src={job.layer_edit_result.image} alt="保存済みの透過編集候補"/>}
 </>}
 </details>;
}
