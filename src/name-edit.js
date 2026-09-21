import {sourceReplanInput,makeSourceCandidate} from './source-replan.js';
import {refKey} from './source-refs.js';
import {defaultLettering} from './lettering.js';
import {validateSourcePatch} from './source-application.js';

export function namePanels(candidate){
 const prefix=`source:${candidate.prepared.identity.opId}:panel:`;
 return candidate.patch.panels.filter(p=>p.id.startsWith(prefix)||(candidate.prepared.plan.scope.panelIds??[]).includes(p.id));
}
export function validateName(project,candidate){
 const preview={...candidate.patch,panels:candidate.patch.panels.map(p=>p.image?p:{...p,image:'planned'})};
 validateSourcePatch(project,candidate.prepared.expected,preview);
 return candidate;
}
// Reassignment changes boundaries between ordered SourceRefs, never the source text.
export function editName(project,candidate,groups){
 if(candidate.nameConfirmed)throw Error('ネームの確定を解除してから編集してください');
 const old=namePanels(candidate),expected=old.flatMap(p=>p.sourceRefs).map(refKey);
 if(groups.some(g=>!g.refs.length)||JSON.stringify(groups.flatMap(g=>g.refs.map(refKey)))!==JSON.stringify(expected))throw Error('原文の欠落・重複・順序変更はできません');
 const atoms=sourceReplanInput(project,candidate.prepared.expected).atoms;
 const panels=groups.map((g,i)=>{
  const source=old.find(p=>p.id===g.id)??old[0];
  if(source&&JSON.stringify(source.sourceRefs)===JSON.stringify(g.refs))return structuredClone(source);
  const id=`source:${candidate.prepared.identity.opId}:panel:${crypto.randomUUID()}`;
  const p={...source,id,sourceRefs:g.refs,snapshotId:g.refs[0].snapshotId,sceneId:g.refs[0].sceneId,image:null,artwork_revision:null,capture_revision:null,status:'planned'};
  delete p.shot_binding;delete p.live_binding;delete p.compositor;
  p.lettering=defaultLettering({...p,sourceRefs:g.refs.flatMap(r=>atoms.filter(a=>refKey(a.source)===refKey(r)).flatMap(a=>a.requiredText))});
  return p;
 });
 const next=makeSourceCandidate(project,candidate.prepared,[...candidate.patch.panels.filter(p=>!old.some(o=>o.id===p.id)),...panels],panels.filter(p=>!p.image).map(p=>p.id),candidate.reason);
 // Unchanged panel IDs retain manually placed geometry when count does not change.
 if(panels.length===old.length){const byId=new Map(old.map((p,i)=>[p.id,panels[i].id]));next.patch.layout=structuredClone(candidate.patch.layout);for(const page of next.patch.layout.pages)for(const slot of page.slots)if(byId.has(slot.panelId))slot.panelId=byId.get(slot.panelId);
  if(next.patch.layout.imageCrops){const crops={};for(const [id,crop] of Object.entries(next.patch.layout.imageCrops))crops[byId.get(id)??id]=crop;next.patch.layout.imageCrops=crops;}
 }
 return validateName(project,{...candidate,...next,nameConfirmed:false});
}
