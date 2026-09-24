import React,{useEffect,useMemo,useState} from 'react';
import { assignMotion, removeMotion, undoMotion, motionStatus, shotFromPanel } from './panel-motion';
import { adjacentPanelPairs } from './video-transition';
import { defaultVideoModelId, videoModel, videoModels } from './media.js';
import { panelVideoDefaults } from './video-batch.js';
import { adoptVideoCandidate, undoVideo } from './video.js';
import { videoStatusLabel } from './video-remote.js';
import { executeVideo } from './media-runtime.js';
import { call, desktop, loadProject } from './bridge.js';
import { convertFileSrc } from '@tauri-apps/api/core';
export default function PanelMotionControls({project,panel,current,commit,run,busy,onShot,onAdjacentPair,onGenerate,videoModelId=project.mediaDefaults?.video??defaultVideoModelId,videoConnections={},active=true}) {
 const [open,setOpen]=useState(false),[shot,setShot]=useState(''),[prompt,setPrompt]=useState(''),[ratio,setRatio]=useState('960:960'),[status,setStatus]=useState('動画なし'),[playback,setPlayback]=useState(null);
 const ratios=videoModel(project.mediaDefaults?.video ?? defaultVideoModelId).input.ratios;
 useEffect(()=>{if(!ratios.includes(ratio))setRatio(ratios[0]);},[ratios,ratio]);
 useEffect(()=>{setPrompt('');setShot('');setPlayback(null);},[panel.id]);
 useEffect(()=>{if(!active||!open)return;let live=true;motionStatus(project,panel).then(s=>{if(live)setStatus(s.message);});return()=>{live=false;};},[active,open,project,panel]);
 const adjacent=useMemo(()=>active&&open?adjacentPanelPairs(project).find(pair=>pair.fromPanelId===panel.id):null,[active,open,project,panel.id]);
 const matches=s=>!s.transition&&s.startImage?.id===panel.artwork_revision&&s.snapshotId===panel.snapshotId&&s.sceneId===panel.sceneId&&JSON.stringify(s.unitIds)===JSON.stringify(panel.unitIds)&&JSON.stringify(s.sourceRefs??null)===JSON.stringify(panel.sourceRefs??null)&&JSON.stringify(s.characterIds)===JSON.stringify(panel.characterIds);
 const available=project.videoShots.filter(s=>s.adopted_revision&&matches(s));
 const selectedShot=available.some(s=>s.id===shot)?shot:(available.length===1?available[0].id:'');
 const defaults=panelVideoDefaults(project,panel.id,videoModelId);
 const produced=project.videoShots.filter(matches);
 const jobs=produced.flatMap(s=>project.jobs.filter(j=>j.scope?.type==='videoShot'&&j.scope.id===s.id));
 async function verify(artifact) {
  const revision=current.current.videoRevisions.find(v=>v.artifact.hash===artifact.hash&&v.artifact.size===artifact.size);
  if(!revision)throw Error('保存された動画版がありません');
  const response=await call('video_playback',{revisionId:revision.id});
  if(response.artifact.hash!==artifact.hash||response.artifact.size!==artifact.size)throw Error('動画版が一致しません');
  return response;
 }
 async function refresh() {const latest=await loadProject();if(!latest)throw Error('作品を再読込できません');await commit(latest);}
 async function updateTask(job,action) {
  const selected=videoModels.find(item=>item.provider===job.manifest?.connection?.provider&&item.model_id===job.manifest?.connection?.model);
  const connectionId=selected&&videoConnections[selected.id];
  if(!connectionId)throw Error('生成時と同じ動画接続を登録してください');
  try {await executeVideo('task',selected.id,connectionId,{jobId:job.id,action});}
  finally {await refresh();}
 }
 return <section className="shot-controls" aria-label="コマの動画">
 <button className="primary" disabled={busy||!desktop()||!defaults.valid||!onGenerate} onClick={()=>onGenerate(panel.id,prompt.trim())}>このコマから動画を生成</button>
 {defaults.valid ? <small>{videoModel(videoModelId).display_name} · {defaults.duration}秒 · {defaults.estimate?`最大${defaults.estimate.credits} credits`:'このMacで生成'} · 動きは画像と原稿から自動作成</small> : <p role="alert">{defaults.reason}</p>}
 {produced.length>0&&<small>最後に保存した動き: {produced.at(-1).prompt}</small>}
 {jobs.map(j=><p key={j.id} role="status">{videoStatusLabel(j)}{j.remote?.task_id&&<><button disabled={busy} onClick={()=>run('動画の状態を更新',()=>updateTask(j,'status'))}>状態を更新</button>{j.remote.status==='SUCCEEDED'&&<button disabled={busy} onClick={()=>run('動画を取得',()=>updateTask(j,'collect'))}>動画を取得</button>}</>}</p>)}
 {produced.flatMap(s=>project.videoRevisions.filter(v=>v.shot_id===s.id).map(v=><div key={v.id}>
   <span>{s.adopted_revision===v.id?'採用中':'動画候補'}</span>
   <button disabled={busy} onClick={()=>run('動画を再生',async()=>{const response=await verify(v.artifact);setPlayback({id:v.id,src:convertFileSrc(response.path)});})}>再生</button>
   <button disabled={busy||project.jobs.find(j=>j.id===v.job_id)?.status!=='candidate'} onClick={()=>run('動画候補を採用',async()=>commit(await adoptVideoCandidate(current.current,v.job_id,verify)))}>採用</button>
   {s.adopted_revision===v.id&&project.videoHistory.some(h=>h.shot_id===s.id)&&<button disabled={busy} onClick={()=>run('動画の採用を元に戻す',async()=>commit(await undoVideo(current.current,s.id,verify)))}>採用を元に戻す</button>}
 </div>))}
 {playback&&<video key={playback.id} controls playsInline preload="metadata" src={playback.src}/>}
 <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>動きの指示を調整・動画を割り当てる</summary>{open&&<><p role="status">{status}</p><fieldset disabled={busy}>
 <label>動きの指示を上書き（任意）<textarea value={prompt} maxLength={1000} onChange={e=>setPrompt(e.target.value)}/></label><label>動画の寸法<select value={ratio} onChange={e=>setRatio(e.target.value)}>{ratios.map(r=><option key={r}>{r}</option>)}</select></label>
 <button disabled={!panel.image||!prompt.trim()} onClick={()=>run('コマの動画を準備',async()=>{const next=await shotFromPanel(current.current,panel.id,prompt,ratio);await commit(next);onShot(next.videoShots.at(-1).id);})}>この作画から動画を準備</button>
 {adjacent&&<button disabled={!adjacent.valid} onClick={()=>onAdjacentPair?.(adjacent.id)}>次のコマとのA→B動画を選ぶ</button>}
 {adjacent&&!adjacent.valid&&<small role="alert">{adjacent.reason}</small>}
 {!!available.length&&<><label>採用済み動画<select value={selectedShot} onChange={e=>setShot(e.target.value)}><option value="">動画を選択</option>{available.map((s,i)=><option key={s.id} value={s.id}>{i+1} · {s.sceneId}</option>)}</select></label>
 <button disabled={!selectedShot} onClick={()=>run('動画を割当',async()=>commit(await assignMotion(current.current,panel.id,selectedShot)))}>動画を割り当てる</button></>}
 {project.panelMotions?.some(b=>b.panelId===panel.id)&&<button onClick={()=>run('割当を解除',()=>commit(removeMotion(current.current,panel.id)))}>割当を解除</button>}
 {project.motionHistory?.some(h=>h.panelId===panel.id)&&<button onClick={()=>run('割当を元に戻す',()=>commit(undoMotion(current.current,panel.id)))}>割当を元に戻す</button>}</fieldset></>}</details></section>;
}
