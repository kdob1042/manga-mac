import { recordCapture } from './shots.js';
export async function recordLiveCandidate(project,panelId,response,basePanel) {
  const panel=project.panels.find(p=>p.id===panelId);
  if(!panel||JSON.stringify(panel)!==JSON.stringify(basePanel)) throw Error('候補保存中に対象コマが変わりました。保存された撮影を確認してください');
  const binding={id:response.session_id,session_id:response.session_id,source_revision:panel.snapshotId,origin_hash:response.state?.checkpoint?.hash};
  const mapped=(project.character_bindings??[]).filter(b=>b.shot_id===panel.shot_binding?.id).map(b=>{const live=panel.live_binding?.character_objects?.find(x=>x.character_id===b.character_id);return live?{...b,object_name:live.object_name,asset_ref:{...b.asset_ref,object:live.object_name}}:b;});
  const scene=response.state?.scenes?.find(s=>s.name===response.state?.state?.scene);
  if(mapped.some(b=>!scene?.objects.includes(b.object_name)))throw Error('人物対応が候補のSceneにありません。対応付けを確認してください');
  const character_bindings=[...(project.character_bindings??[]),...mapped.map(b=>({...b,shot_id:binding.id,asset_ref:{...b.asset_ref,blend_hash:binding.origin_hash}}))];
  const temporary={...project,character_bindings,panels:project.panels.map(p=>p.id===panelId?{...p,shot_binding:binding}:p)};
  const captured=await recordCapture(temporary,panelId,response);
  const id=`live:${response.request_id}`;
  if(project.live_candidates?.some(c=>c.id===id)) return project;
  return {...project,character_bindings,captures:captured.captures,live_candidates:[...(project.live_candidates??[]),{
    id,panel_id:panelId,source_revision:panel.snapshotId,base_capture:panel.capture_revision??null,
    base_binding:panel.shot_binding??null,shot_binding:binding,capture_revision:`capture:${response.request_id}`,status:'candidate',
  }]};
}
export function adoptLiveCandidate(project,id) {
  const candidate=project.live_candidates?.find(c=>c.id===id&&c.status==='candidate');
  const panel=project.panels.find(p=>p.id===candidate?.panel_id);
  if(!panel||panel.snapshotId!==candidate.source_revision||(panel.capture_revision??null)!==candidate.base_capture||JSON.stringify(panel.shot_binding??null)!==JSON.stringify(candidate.base_binding)) throw Error('候補の基準版が変わりました。旧採用版は保持されています');
  return {...project,history:[...project.history,{panels:project.panels,label:'live Blender候補を採用',at:new Date().toISOString()}],
    panels:project.panels.map(p=>p.id===panel.id?{...p,shot_binding:candidate.shot_binding,capture_revision:candidate.capture_revision}:p)};
}
