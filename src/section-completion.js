import {buildChangeSet} from './source-diff.js';
import {validateApplication} from './source-application.js';
import {sourceResolver} from './source-refs.js';

const snapshot=p=>p.snapshots.find(s=>s.id===p.active);
export const sectionKey=(p,id)=>`${p.workId??snapshot(p)?.repo??''}:${snapshot(p)?.scenes.find(s=>s.id===id)?.episodeId??snapshot(p)?.episodeId??''}:${id}`;
export function sectionPanels(p,id){return p.panels.filter(panel=>panel.sceneId===id||(panel.sourceRefs??[]).some(r=>r.sceneId===id));}
export function sectionVersion(p,id){
 const source=snapshot(p),scene=source?.scenes.find(s=>s.id===id);if(!scene)return null;
 const panels=sectionPanels(p,id),ids=new Set(panels.map(x=>x.id)),resolve=sourceResolver(p.snapshots);
 const refs=rs=>(rs??[]).map(r=>({sceneId:r.sceneId,startCp:r.startCp,endCp:r.endCp,text:resolve(r)}));
 return JSON.stringify({text:scene.text,design:scene.design??'',settings:(source.settings??[]).map(s=>({id:s.id,text:s.text})),
  characters:p.characters.filter(c=>panels.some(panel=>panel.characterIds.includes(c.id))).map(c=>({id:c.id,hash:c.hash,description:c.description})),styles:(p.style_references??[]).map(s=>({id:s.id,hash:s.hash})),
  panels:panels.map(x=>({id:x.id,refs:refs(x.sourceRefs),artwork:x.artwork_revision,image:x.artwork_revision?undefined:x.image,lettering:x.lettering?{...x.lettering,boxes:x.lettering.boxes.map(b=>({...b,sourceRefs:refs(b.sourceRefs)}))}:null})),
  slots:p.layout.pages.flatMap(page=>page.slots.filter(s=>ids.has(s.panelId)).map(s=>({pageId:page.id,...s}))),crops:panels.map(x=>[x.id,p.layout.imageCrops?.[x.id]??null])});
}
export function completionProblems(p,id){
 const source=snapshot(p),scene=source?.scenes.find(s=>s.id===id),panels=sectionPanels(p,id),ids=new Set(panels.map(x=>x.id)),errors=[];
 if(!scene)return ['原稿が削除されています'];
 if(!p.contentToken||!p.workId||!p.sourceApplication)return ['原稿を保存・移行してから完了を承認してください'];
 const changes=buildChangeSet(p);
 if(changes.blocks.some(b=>[...(b.newRefs??[]),...(b.oldUnitIds??[]).flatMap(uid=>p.sourceApplication?.units.filter(u=>u.id===uid).map(u=>u.source)??[])].some(r=>r.sceneId===id)))errors.push('未割当または未反映の原稿があります');
 if(!panels.length)errors.push('コマがありません');
 if(panels.some(x=>!x.image))errors.push('未作画のコマがあります');
 const affects=j=>{
  if(ids.has(j.panelId))return true;
  const owner=j.sourcePatchOp?p.jobs.find(o=>o.id===j.sourcePatchOp):j;
  const edits=owner?.source_patch?.expected?.sourceEdits??owner?.source_candidate?.prepared?.expected?.sourceEdits??[];
  return edits.some(e=>(e.newRefs??[]).some(r=>r.sceneId===id)||(e.oldUnitIds??[]).some(uid=>p.sourceApplication.units.some(u=>u.id===uid&&u.source.sceneId===id)));
 };
 if(p.jobs.some(j=>(['running','unknown'].includes(j.status)||(!['complete','cancelled'].includes(j.status)&&['waiting','planning','drawing','stopping'].includes(j.run?.stage)))&&affects(j)))errors.push('実行中・応答未確定の処理があります');
 try{validateApplication(p,(p.sourceApplication?.units??[]).filter(u=>u.source.sceneId===id));}catch(e){errors.push(e.message);}
 return [...new Set(errors)];
}
export function sectionStatus(p,id){
 if(!snapshot(p)?.scenes.some(s=>s.id===id))return '削除対象';
 const entry=p.sectionCompletions?.[sectionKey(p,id)];
 if(entry)return entry.version===sectionVersion(p,id)?'完了':'要確認';
 return sectionPanels(p,id).length?'制作中':'未着手';
}
export function completeSection(p,id){
 const problems=completionProblems(p,id);if(problems.length)throw Error(problems.join(' / '));
 return {...p,sectionCompletionUndo:[...(p.sectionCompletionUndo??[]),p.sectionCompletions??{}].slice(-30),sectionCompletions:{...p.sectionCompletions,[sectionKey(p,id)]:{sceneId:id,version:sectionVersion(p,id),at:new Date().toISOString()}}};
}
export function reopenSection(p,id){const entries={...p.sectionCompletions};delete entries[sectionKey(p,id)];return {...p,sectionCompletionUndo:[...(p.sectionCompletionUndo??[]),p.sectionCompletions??{}].slice(-30),sectionCompletions:entries};}
export function undoCompletion(p){const stack=p.sectionCompletionUndo??[];if(!stack.length)return p;return {...p,sectionCompletions:stack.at(-1),sectionCompletionUndo:stack.slice(0,-1)};}
