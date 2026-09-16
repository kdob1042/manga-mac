import { imageHash } from './revisions.js';
import { createVideoShot, validateVideoFrame } from './video.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function motionStatus(project,panel,binding=project.panelMotions?.find(b=>b.panelId===panel.id)) {
 if(!binding)return {state:'none',message:'動画なし'};
 try {
  const a=project.artworks.find(a=>a.id===panel.artwork_revision),v=project.videoRevisions.find(v=>v.id===binding.videoRevision),j=project.jobs.find(j=>j.id===v?.job_id),s=project.videoShots.find(s=>s.id===binding.shotId);
  if(!a||!v||!j||!s||a.id!==binding.artworkRevision||a.hash!==binding.artworkHash||await imageHash(panel.image)!==a.hash||v.artifact.hash!==binding.videoHash||v.shot_id!==s.id||v.input_hash!==j.input_hash)throw Error('作画または動画版が変わっています');
  const input=j.manifest?.providerInputs,source=j.manifest?.source,snapshot=project.snapshots.find(x=>x.id===panel.snapshotId);
  if(!same(binding.source,{snapshotId:panel.snapshotId,sceneId:panel.sceneId,unitIds:panel.unitIds,characterIds:panel.characterIds})||source?.snapshotId!==panel.snapshotId||source?.commit!==snapshot?.sha||source?.sceneId!==panel.sceneId||!same(source?.unitIds,panel.unitIds)||!same(j.manifest?.characterIds,panel.characterIds))throw Error('コマと動画の原作範囲が一致しません');
  if(input?.length!==1||input[0].id!==a.id||input[0].hash!==a.hash||input[0].role!=='start_frame'||!same(input[0].transform,{kind:'identity'}))throw Error('動画へ送った開始画像が一致しません');
  validateVideoFrame(panel.image,j.manifest.ratio);
  return {state:s.adopted_revision===v.id?'ready':'update',message:s.adopted_revision===v.id?'動画を割当済み':'別の採用版があります（公開版は固定）',revision:v};
 }catch(e){return {state:'stale',message:e.message};}
}
export async function assignMotion(project,panelId,shotId) {
 const p=project.panels.find(p=>p.id===panelId),s=project.videoShots.find(s=>s.id===shotId),v=project.videoRevisions.find(v=>v.id===s?.adopted_revision),a=project.artworks.find(a=>a.id===p?.artwork_revision);
 if(!p||!s||!v||!a)throw Error('採用した作画と動画を選んでください');
 const binding={panelId,shotId,videoRevision:v.id,videoHash:v.artifact.hash,artworkRevision:a.id,artworkHash:a.hash,source:{snapshotId:p.snapshotId,sceneId:p.sceneId,unitIds:[...p.unitIds],characterIds:[...p.characterIds]}};
 const status=await motionStatus(project,p,binding);if(status.state==='stale')throw Error(status.message);
 return change(project,panelId,binding);
}
function change(project,panelId,binding) {return {...project,panelMotions:[...(project.panelMotions??[]).filter(b=>b.panelId!==panelId),...(binding?[binding]:[])],motionHistory:[...(project.motionHistory??[]),{panelId,previous:project.panelMotions?.find(b=>b.panelId===panelId)??null}]};}
export const removeMotion=(p,id)=>change(p,id,null);
export function undoMotion(project,panelId) {const i=project.motionHistory.findLastIndex(h=>h.panelId===panelId);if(i<0)throw Error('戻す割当がありません');return {...change(project,panelId,project.motionHistory[i].previous),motionHistory:project.motionHistory.filter((_,n)=>n!==i)};}
export async function shotFromPanel(project,panelId,prompt,ratio) {
 const panel=project.panels.find(p=>p.id===panelId),a=project.artworks.find(a=>a.id===panel?.artwork_revision);
 if(!a||a.hash!==await imageHash(panel.image))throw Error('採用作画を確認してください');validateVideoFrame(panel.image,ratio);
 return createVideoShot(project,{snapshotId:panel.snapshotId,sceneId:panel.sceneId,unitIds:[...panel.unitIds],characterIds:[...panel.characterIds],startImage:{kind:'artwork',id:a.id,hash:a.hash},prompt,duration:5,ratio});
}
