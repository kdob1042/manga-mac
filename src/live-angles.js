import {withResource} from './execution.js';
import {liveCall,liveWork,livePlanGuard,handoffLive,assertLiveTarget,observationKey,verifyLiveMappings} from './live-blender.js';
import {recordLiveCandidate} from './live-candidates.js';

export async function captureAngles({current,commit,call,panelId,targetObject,degrees=[-30,0,30],width=768,height=768,cancelled=()=>false,notify=()=>{},onCapture=()=>{}}) {
 if(!Array.isArray(degrees)||degrees.length<1||degrees.length>5||new Set(degrees).size!==degrees.length||degrees.some(n=>!Number.isFinite(n)||Math.abs(n)>180))throw Error('異なるアングルを1〜5個、-180〜180度で指定してください');
 return withResource('blender-session',1,async()=>{
  const project=current(),panel=project.panels.find(p=>p.id===panelId);
  if(!panel?.live_binding)throw Error('対象コマのBlenderを開いてください');
  await handoffLive(call,project);
  const planValid=livePlanGuard(project), baseline=JSON.stringify(panel), work=liveWork(project);
  const check=()=>{
   if(cancelled()||!planValid())throw Error('撮影を停止しました。保存済みの候補は残っています');
   if(liveWork(current())!==work||JSON.stringify(current().panels.find(p=>p.id===panelId))!==baseline)throw Error('撮影対象が変わりました');
  };
  check();let state=await liveCall(call,project,'observe',{scope:'summary'});
  assertLiveTarget(panel.live_binding,state);verifyLiveMappings(project,panel,state);
  const detail=await liveCall(call,project,'observe',{scope:'object',object:targetObject});
  if(observationKey(detail)!==observationKey(state))throw Error('観測中に状態が変わりました');
  const target=detail.evaluated_world?.slice(0,3).map(row=>row[3]);
  if(!target||target.length!==3||target.some(n=>!Number.isFinite(n)))throw Error('注視対象の位置を取得できません');
  let expected=state;const ids=[];
  for(const angle of degrees){
   check();state=await liveCall(call,current(),'observe',{scope:'summary'});
   assertLiveTarget(panel.live_binding,state);
   if(observationKey(state)!==observationKey(expected))throw Error('Blenderが変更されたため残りの撮影を停止しました');
   check();notify(`${angle}°の候補を撮影中`);
   const response=await call('blender_live_candidate',{input:{work,expected:state,width,height,angle:{degrees:angle,target}}});
   // Persist the completed capture even if the user requested a stop during rendering.
   const recorded=await recordLiveCandidate(current(),panelId,response,panel);
   const id=`live:${response.request_id}`;
   await commit({...recorded,live_candidates:recorded.live_candidates.map(c=>c.id===id?{...c,angle:{degrees:angle,target,object:targetObject},label:`${angle}°`}:c)});
   onCapture({id,preview:response.preview,angle});
   ids.push(id);expected=response.live_observation;
   if(!expected)throw Error('撮影後の状態を確認できません。残りは撮影しません');
  }
  return ids;
 },{cancelled});
}
