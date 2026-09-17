import { defaultLettering, validateLettering } from './lettering.js';
import { sourceForPanel } from './core.js';
export const letteringSchema={type:'object',properties:{reason:{type:'string'},layout:{type:'object',properties:{mode:{type:'string',enum:['balloons','caption']},boxes:{type:'array',items:{type:'object',properties:{id:{type:'string'},unit_id:{type:'string'},x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'},shape:{type:'string',enum:['round','rect','ellipse']},fontSize:{type:'number'},lineHeight:{type:'number'},padding:{type:'number'},locked:{type:'boolean'}},required:['unit_id','x','y','width','height'],additionalProperties:false}}},required:['mode','boxes'],additionalProperties:false}},required:['reason','layout'],additionalProperties:false};
export async function proposeLettering(project,panel,instruction,ask) {
  const current=panel.lettering??defaultLettering(panel);
  const snapshot=project.snapshots.find(s=>s.id===panel.snapshotId);
  const prompt=JSON.stringify({task:'原文を変更せず漫画の文字を配置。全unit_idを既存順で一度ずつ残す。固定した枠は全フィールドを保持。通常はballoons。座標は0〜1、文字サイズ14〜72。画像入力はないので顔や人物位置を認識したと述べない。まず文字量と読書順から配置する。重なりを避け、入りきらなければcaption。',instruction,current,units:panel.unitIds.map(id=>({id,text:sourceForPanel({...panel,unitIds:[id]},snapshot)}))});
  const result=JSON.parse(await ask(prompt,letteringSchema));
  if(typeof result.reason!=='string')throw Error('文字配置の理由がありません');
  validateLettering(panel,result.layout);
  for(const b of current.boxes)if(b.locked && JSON.stringify(b)!==JSON.stringify(result.layout.boxes.find(x=>x.unit_id===b.unit_id)))throw Error('固定した文字枠を変更する案は採用できません');
  return result.layout;
}
