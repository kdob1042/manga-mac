import {letteringRegions,checkVisualEdit} from './visual-regions.js';
import { defaultLettering, validateLettering } from './lettering.js';
import { sourceForPanel } from './core.js';
export const letteringSchema={type:'object',properties:{reason:{type:'string'},layout:{type:'object',properties:{mode:{type:'string',enum:['balloons','caption']},boxes:{type:'array',items:{type:'object',properties:{id:{type:'string'},unit_id:{type:'string'},x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'},shape:{type:'string',enum:['round','rect','ellipse']},fontSize:{type:'number'},lineHeight:{type:'number'},padding:{type:'number'},locked:{type:'boolean'},tail:{anyOf:[{type:'null'},{type:'array',minItems:2,maxItems:2,items:{type:'number'}}]}},required:['unit_id','x','y','width','height'],additionalProperties:false}}},required:['mode','boxes'],additionalProperties:false}},required:['reason','layout'],additionalProperties:false};
export async function proposeLettering(project,panel,instruction,ask,visual=null) {
  const current=panel.lettering??defaultLettering(panel);
  const snapshot=project.snapshots.find(s=>s.id===panel.snapshotId);
  const prompt=JSON.stringify({task:'原文を変更せず漫画の文字を配置。全unit_idを既存順で一度ずつ残す。固定した枠は全フィールドを保持。通常はballoons。座標は0〜1、文字サイズ14〜72。regionsがある場合は画像から認識したavoid矩形（文字枠と同じ座標）を避ける。なければ画像内の位置は不明とし、文字量と読書順から配置する。重なりを避け、入りきらなければcaption。',instruction,current,regions:visual?letteringRegions(project,panel.id,visual):null,units:panel.unitIds.map(id=>({id,text:sourceForPanel({...panel,unitIds:[id]},snapshot)}))});
  const result=JSON.parse(await ask(prompt,letteringSchema));
  if(typeof result.reason!=='string')throw Error('文字配置の理由がありません');
  validateLettering(panel,result.layout);
  if(current.boxes.some(b=>b.locked)&&current.mode!==result.layout.mode)throw Error('固定した文字配置の表示方法は変更できません');
  checkVisualEdit(project,{kind:'lettering',panelId:panel.id,args:result.layout},visual);
  for(const b of current.boxes)if(b.locked && JSON.stringify(b)!==JSON.stringify(result.layout.boxes.find(x=>x.unit_id===b.unit_id)))throw Error('固定した文字枠を変更する案は採用できません');
  return result.layout;
}
