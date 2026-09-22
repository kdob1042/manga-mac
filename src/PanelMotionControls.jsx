import React,{useEffect,useMemo,useState} from 'react';
import { assignMotion, removeMotion, undoMotion, motionStatus, shotFromPanel } from './panel-motion';
import { adjacentPanelPairs } from './video-transition';
import { defaultVideoModelId, videoModel } from './media.js';
export default function PanelMotionControls({project,panel,current,commit,run,busy,onShot,onAdjacentPair,active=true}) {
 const [open,setOpen]=useState(false),[shot,setShot]=useState(''),[prompt,setPrompt]=useState(''),[ratio,setRatio]=useState('960:960'),[status,setStatus]=useState('動画なし');
 const ratios=videoModel(project.mediaDefaults?.video ?? defaultVideoModelId).input.ratios;
 useEffect(()=>{if(!ratios.includes(ratio))setRatio(ratios[0]);},[ratios,ratio]);
 useEffect(()=>{setPrompt('');setShot('');},[panel.id]);
 useEffect(()=>{if(!active||!open)return;let live=true;motionStatus(project,panel).then(s=>{if(live)setStatus(s.message);});return()=>{live=false;};},[active,open,project,panel]);
 const adjacent=useMemo(()=>active&&open?adjacentPanelPairs(project).find(pair=>pair.fromPanelId===panel.id):null,[active,open,project,panel.id]);
 const available=project.videoShots.filter(s=>s.adopted_revision&&!s.transition&&s.startImage?.id===panel.artwork_revision&&s.snapshotId===panel.snapshotId&&s.sceneId===panel.sceneId&&JSON.stringify(s.unitIds)===JSON.stringify(panel.unitIds));
 const selectedShot=available.some(s=>s.id===shot)?shot:(available.length===1?available[0].id:'');
 return <section className="shot-controls" aria-label="コマの動画"><details open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>このコマを動かす</summary>{open&&<><p role="status">{status}</p><fieldset disabled={busy}>
 <label>動きの指示<textarea value={prompt} maxLength={1000} onChange={e=>setPrompt(e.target.value)}/></label><label>動画の寸法<select value={ratio} onChange={e=>setRatio(e.target.value)}>{ratios.map(r=><option key={r}>{r}</option>)}</select></label>
 <button disabled={!panel.image||!prompt.trim()} onClick={()=>run('コマの動画を準備',async()=>{const next=await shotFromPanel(current.current,panel.id,prompt,ratio);await commit(next);onShot(next.videoShots.at(-1).id);})}>この作画から動画を準備</button>
 {adjacent&&<button disabled={!adjacent.valid} onClick={()=>onAdjacentPair?.(adjacent.id)}>次のコマとのA→B動画を選ぶ</button>}
 {adjacent&&!adjacent.valid&&<small role="alert">{adjacent.reason}</small>}
 {!!available.length&&<><label>採用済み動画<select value={selectedShot} onChange={e=>setShot(e.target.value)}><option value="">動画を選択</option>{available.map((s,i)=><option key={s.id} value={s.id}>{i+1} · {s.sceneId}</option>)}</select></label>
 <button disabled={!selectedShot} onClick={()=>run('動画を割当',async()=>commit(await assignMotion(current.current,panel.id,selectedShot)))}>動画を割り当てる</button></>}
 {project.panelMotions?.some(b=>b.panelId===panel.id)&&<button onClick={()=>run('割当を解除',()=>commit(removeMotion(current.current,panel.id)))}>割当を解除</button>}
 {project.motionHistory?.some(h=>h.panelId===panel.id)&&<button onClick={()=>run('割当を元に戻す',()=>commit(undoMotion(current.current,panel.id)))}>割当を元に戻す</button>}</fieldset></>}</details></section>;
}
