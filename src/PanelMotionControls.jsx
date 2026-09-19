import React,{useEffect,useState} from 'react';
import { assignMotion, removeMotion, undoMotion, motionStatus, shotFromPanel } from './panel-motion';
export default function PanelMotionControls({project,panel,current,commit,run,busy,onShot}) {
 const [shot,setShot]=useState(''),[prompt,setPrompt]=useState(''),[ratio,setRatio]=useState('960:960'),[status,setStatus]=useState('動画なし');
 useEffect(()=>{let live=true;motionStatus(project,panel).then(s=>{if(live)setStatus(s.message);});return()=>{live=false;};},[project,panel]);
 return <section className="shot-controls" aria-label="コマの動画"><h3>このコマを動かす</h3><p role="status">{status}</p><fieldset disabled={busy}>
 <label>動きの指示<textarea value={prompt} maxLength={1000} onChange={e=>setPrompt(e.target.value)}/></label><label>動画の寸法<select value={ratio} onChange={e=>setRatio(e.target.value)}>{['960:960','1280:720','720:1280','1104:832','832:1104'].map(r=><option key={r}>{r}</option>)}</select></label>
 <button disabled={!panel.image||!prompt.trim()} onClick={()=>run('コマの動画を準備',async()=>{const next=await shotFromPanel(current.current,panel.id,prompt,ratio);await commit(next);onShot(next.videoShots.at(-1).id);})}>この作画から動画を準備</button>
 <label>採用済み動画<select value={shot} onChange={e=>setShot(e.target.value)}><option value="">動画を選択</option>{project.videoShots.filter(s=>s.adopted_revision).map((s,i)=><option key={s.id} value={s.id}>{i+1} · {s.sceneId}</option>)}</select></label>
 <button disabled={!shot} onClick={()=>run('動画を割当',async()=>commit(await assignMotion(current.current,panel.id,shot)))}>動画を割り当てる</button>
 <button disabled={!project.panelMotions?.some(b=>b.panelId===panel.id)} onClick={()=>run('割当を解除',()=>commit(removeMotion(current.current,panel.id)))}>割当を解除</button>
 <button disabled={!project.motionHistory?.some(h=>h.panelId===panel.id)} onClick={()=>run('割当を元に戻す',()=>commit(undoMotion(current.current,panel.id)))}>割当を元に戻す</button></fieldset></section>;
}
