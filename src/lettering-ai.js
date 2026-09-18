import {textForRefs} from './source-refs.js';
import {letteringRegions,checkVisualEdit} from './visual-regions.js';
import { defaultLettering, validateLettering } from './lettering.js';
import { sourceForPanel } from './core.js';
export const letteringSchema={type:'object',properties:{reason:{type:'string'},layout:{type:'object',properties:{mode:{type:'string',enum:['balloons','caption']},boxes:{type:'array',items:{type:'object',properties:{id:{type:'string'},unit_id:{type:'string'},x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'},kind:{type:'string',enum:['balloon','narration','plain']},shape:{type:'string',enum:['round','rect','ellipse']},fontSize:{type:'number'},lineHeight:{type:'number'},padding:{type:'number'},locked:{type:'boolean'},tail:{anyOf:[{type:'null'},{type:'array',minItems:2,maxItems:2,items:{type:'number'}}]}},required:['unit_id','x','y','width','height'],additionalProperties:false}}},required:['mode','boxes'],additionalProperties:false}},required:['reason','layout'],additionalProperties:false};
export async function proposeLettering(project,panel,instruction,ask,visual=null) {
  if(panel.sourceRefs)return proposeReferencedLettering(project,panel,instruction,ask,visual);
  const current=panel.lettering??defaultLettering(panel);
  const snapshot=project.snapshots.find(s=>s.id===panel.snapshotId);
  const prompt=JSON.stringify({task:'原文を変更せず漫画の文字を配置。全unit_idを既存順で一度ずつ残す。固定した枠は全フィールドを保持。各枠にkind=balloon（吹き出し）、narration（コマ内の四角いナレーション枠）、plain（枠なしテキスト）のいずれかを指定する。通常はballoons。座標は0〜1、文字サイズ14〜72。regionsがある場合は画像から認識したavoid矩形（文字枠と同じ座標）を避ける。なければ画像内の位置は不明とし、文字量と読書順から配置する。重なりを避け、入りきらなければcaption。',instruction,current,regions:visual?letteringRegions(project,panel.id,visual):null,units:panel.unitIds.map(id=>({id,text:sourceForPanel({...panel,unitIds:[id]},snapshot)}))});
  const result=JSON.parse(await ask(prompt,letteringSchema));
  if(typeof result.reason!=='string')throw Error('文字配置の理由がありません');
  validateLettering(panel,result.layout);
  if(current.boxes.some(b=>b.locked)&&current.mode!==result.layout.mode)throw Error('固定した文字配置の表示方法は変更できません');
  checkVisualEdit(project,{kind:'lettering',panelId:panel.id,args:result.layout},visual);
  for(const b of current.boxes)if(b.locked && JSON.stringify(b)!==JSON.stringify(result.layout.boxes.find(x=>x.unit_id===b.unit_id)))throw Error('固定した文字枠を変更する案は採用できません');
  return result.layout;
}

// The model moves stable text boxes; it never invents immutable source offsets.
const referencedBoxSchema=structuredClone(letteringSchema.properties.layout.properties.boxes.items);
delete referencedBoxSchema.properties.unit_id;
referencedBoxSchema.required=['id','x','y','width','height'];
export const referencedLetteringSchema=structuredClone(letteringSchema);
referencedLetteringSchema.properties.layout.properties.boxes.items=referencedBoxSchema;
async function proposeReferencedLettering(project,panel,instruction,ask,visual){
 const current=panel.lettering??defaultLettering(panel);
 validateLettering(panel,current);
 const result=JSON.parse(await ask(JSON.stringify({
  task:'漫画の文字配置だけを提案。既存のbox IDを全て同じ順序で一度ずつ残す。本文の追加・省略・変更・分割はしない。固定した枠は表示方法と全ての値を保持する。座標0〜1、文字サイズ14〜72。重要領域を避け、入りきらなければcaption。原稿の範囲は返さない。',
  instruction,mode:current.mode,current:{mode:current.mode,boxes:current.boxes.map(({sourceRefs,unit_id,...box})=>box)},
  boxes:current.boxes.map(({sourceRefs,unit_id,...box})=>({...box,text:textForRefs(sourceRefs,project.snapshots)})),
  regions:visual?letteringRegions(project,panel.id,visual):null,
 }),referencedLetteringSchema));
 if(typeof result.reason!=='string'||!result.layout||!Array.isArray(result.layout.boxes))throw Error('文字配置の応答が不正です');
 if(JSON.stringify(result.layout.boxes.map(b=>b.id))!==JSON.stringify(current.boxes.map(b=>b.id)))throw Error('文字枠の欠落・重複・順序変更はできません');
 const boxes=result.layout.boxes.map((box,i)=>{
  if(Object.keys(box).some(k=>!Object.hasOwn(referencedBoxSchema.properties,k)))throw Error('文字配置の未対応項目です');
  return {...current.boxes[i],...box,sourceRefs:structuredClone(current.boxes[i].sourceRefs),...(current.boxes[i].unit_id!==undefined?{unit_id:current.boxes[i].unit_id}:{})};
 });
 const layout={...result.layout,boxes};validateLettering(panel,layout);
 if(current.boxes.some(b=>b.locked)&&current.mode!==layout.mode)throw Error('固定した文字配置の表示方法は変更できません');
 for(const [i,b] of current.boxes.entries())if(b.locked&&JSON.stringify(b)!==JSON.stringify({...b,...boxes[i]}))throw Error('固定した文字枠を変更する案は採用できません');
 checkVisualEdit(project,{kind:'lettering',panelId:panel.id,args:layout},visual);
 return layout;
}
