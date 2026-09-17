import {buildAffectedScope,validateSourcePatch} from './source-application.js';
import {sourceResolver,intersect,refKey} from './source-refs.js';
import {defaultLettering} from './lettering.js';
import {layoutSplice,validateLayoutPatch,template} from './layout.js';
import {contentReplanSchema} from './content-replan.js';

// Extend the existing content planner: model-visible atom IDs are resolved by us.
export const sourceReplanSchema=structuredClone(contentReplanSchema);
const item=sourceReplanSchema.properties.panels.items;
item.properties.reusePanelId={anyOf:[{type:'string'},{type:'null'}]};
item.required.push('reusePanelId');
export function sourceReplanInput(project,expected){
 const scope=buildAffectedScope(project,expected.sourceEdits),old=project.panels.filter(p=>scope.contentPanelIds.includes(p.id));
 const retained=new Set(expected.retainRefs.map(refKey));
 const units=expected.afterUnits.filter(u=>!retained.has(refKey(u.source))||old.some(p=>(p.sourceRefs??[]).some(r=>intersect(r,u.source))));
 const resolve=sourceResolver(project.snapshots);
 const atoms=[];
 for(const u of units){const text=resolve(u.source);let offset=u.source.startCp;
  for(const {segment} of new Intl.Segmenter('ja',{granularity:'sentence'}).segment(text)){
   const source={...u.source,startCp:offset,endCp:offset+[...segment].length};offset=source.endCp;
   const requiredText=u.requiredText.filter(r=>intersect(r,source)).map(r=>({...r,startCp:Math.max(r.startCp,source.startCp),endCp:Math.min(r.endCp,source.endCp)}));
   atoms.push({id:`atom:${atoms.length}`,source,requiredText,text:segment});
  }
 }
 return {scope,old,atoms};
}
export async function proposeSourceReplan(project,prepared,ask){
 const {expected,identity}=prepared,input=sourceReplanInput(project,expected);
 const movesOnly=expected.sourceEdits.every(e=>e.kind==='move');
 if(movesOnly)return makeSourceCandidate(project,prepared,project.panels,[],'原文・画像を保持して移動');
 const response=input.atoms.length?JSON.parse(await ask(JSON.stringify({
  task:'選択した原稿差分だけを漫画へ反映する編集計画。mutableUnitsを全て一度ずつ読書順に割り当てる。原文は変更しない。未選択の旧文も渡された通り保持する。台詞だけの変更は既存画像をreusePanelIdで再利用。描写の視覚変更・新規コマはreusePanelId:null。画像の意味を変える場合は再利用しない。登録済み人物だけを選ぶ。ページ配置や原文の文字offsetは返さない。',
  mutableUnits:input.atoms.map(({id,text})=>({id,text})),
  currentPanels:input.old.map(p=>({id:p.id,prompt:p.prompt,characterIds:p.characterIds,text:(p.sourceRefs??[]).map(sourceResolver(project.snapshots)).join('\n\n'),hasImage:!!p.image})),
  characters:(project.characters??[]).map(({id,name,description})=>({id,name,description})),
 }),sourceReplanSchema)):{reason:'削除された原文に対応するコマを除去',panels:[]};
 if(typeof response.reason!=='string'||!response.reason.trim()||response.reason.length>2000||!Array.isArray(response.panels))throw Error('原稿反映の計画が不正です');
 if(JSON.stringify(response.panels.flatMap(p=>p.unitIds))!==JSON.stringify(input.atoms.map(a=>a.id)))throw Error('選択原文の欠落・重複・順序変更があります');
 const redraw=[];
 const replacements=response.panels.map((plan,i)=>{
  if(!Array.isArray(plan.unitIds)||!plan.unitIds.length||typeof plan.prompt!=='string'||!Array.isArray(plan.characterIds)||plan.characterIds.some(id=>!project.characters.some(c=>c.id===id)))throw Error('コマ計画の内容が不正です');
  const atoms=plan.unitIds.map(id=>input.atoms.find(a=>a.id===id));
  const reuse=plan.reusePanelId===null?null:input.old.find(p=>p.id===plan.reusePanelId&&p.image);
  if(plan.reusePanelId!==null&&!reuse)throw Error('対象外の作画を再利用する案です');
  const refs=atoms.map(a=>a.source);
  if(reuse&&JSON.stringify(reuse.sourceRefs)===JSON.stringify(refs)&&reuse.prompt===plan.prompt&&JSON.stringify(reuse.characterIds)===JSON.stringify(plan.characterIds))return structuredClone(reuse);
  const panel={...(reuse??{}),id:`source:${identity.opId}:panel:${i}`,sceneId:refs[0].sceneId,snapshotId:refs[0].snapshotId,unitIds:[],sourceRefs:refs,contextRefs:[],prompt:plan.prompt,characterIds:plan.characterIds,image:reuse?.image??null,artwork_revision:reuse?.artwork_revision??null,capture_revision:null,reusedPanelId:reuse?.id??null,status:reuse?'review':'planned',instructions:[],attempts:0,replacesPanelIds:input.old.map(p=>p.id)};
  delete panel.shot_binding;
  panel.lettering=defaultLettering({...panel,sourceRefs:atoms.flatMap(a=>a.requiredText)});
  if(!reuse)redraw.push(panel.id);return panel;
 });
 const panels=project.panels.filter(p=>!input.scope.contentPanelIds.includes(p.id)).concat(replacements);
 return makeSourceCandidate(project,prepared,panels,redraw,response.reason);
}
export function makeSourceCandidate(project,prepared,panels,redrawPanelIds,reason){
 const {expected,identity}=prepared;
 const rank=p=>{const indices=expected.afterUnits.flatMap((u,i)=>(p.sourceRefs??[]).some(r=>intersect(r,u.source))?[i]:[]);if(indices.length)return Math.min(...indices);const index=project.panels.findIndex(old=>old.id===p.id);for(let i=index-1;i>=0;i--){const prev=project.panels[i];const found=expected.afterUnits.findIndex(u=>(prev.sourceRefs??[]).some(r=>intersect(r,u.source)));if(found>=0)return found+.5;}return -.5;};
 panels=[...panels].sort((a,b)=>rank(a)-rank(b));
 const pages=project.layout.pages,allowed=new Set(prepared.plan.scope.pageIds),ranges=[];
 for(let i=0;i<pages.length;i++)if(allowed.has(pages[i].id)){const last=ranges.at(-1);if(last?.end===i)last.end=i+1;else ranges.push({start:i,end:i+1});}
 if(!pages.length)ranges.push({start:0,end:0});
 const assigned=page=>page.slots.map(s=>s.panelId).filter(Boolean),splices=[];
 for(const [ri,{start,end}] of ranges.entries()){
  const before=pages.slice(0,start).flatMap(assigned).at(-1),after=pages.slice(end).flatMap(assigned)[0];
  const first=before?panels.findIndex(p=>p.id===before)+1:0,last=after?panels.findIndex(p=>p.id===after):panels.length;
  if(first<0||last<first)throw Error('配置範囲の前後対応が不正です');
  const selected=panels.slice(first,last),capacity=Math.max(1,pages[start]?.slots.length??4),replacement=[];
  const old=pages.slice(start,end),oldSlots=old.flatMap(p=>p.slots);
  if(oldSlots.length===selected.length){let i=0;for(const page of old)replacement.push({...page,slots:page.slots.map(s=>({...s,panelId:selected[i++].id}))});}
  else for(let at=0;at<selected.length;at+=capacity){const i=replacement.length;replacement.push({id:old[i]?.id??`source:${identity.opId}:page:${ri}:${i}`,slots:template(Math.min(capacity,selected.length-at),selected.slice(at,at+capacity).map(p=>p.id)).map((s,j)=>({...s,id:`source:${identity.opId}:slot:${ri}:${i}:${j}`}))});}
  splices.push(layoutSplice(project,start,end-start,replacement));
 }
 const layout=validateLayoutPatch(project,panels,splices);
 for(const panel of panels)if(panel.reusedPanelId&&project.layout.imageCrops?.[panel.reusedPanelId]){layout.imageCrops??={};layout.imageCrops[panel.id]=structuredClone(project.layout.imageCrops[panel.reusedPanelId]);}
 const patch={panels,layout,sourceApplication:{version:1,units:expected.afterUnits}};
 // Required new art keeps this a candidate; no part is adopted until complete.
 if(!redrawPanelIds.length)validateSourcePatch(project,expected,patch);
 return {prepared,patch,reason,redrawPanelIds};
}
export function validateSourceCandidate(project,candidate){
 if(candidate.redrawPanelIds.length)throw Error('新規作画が必要な更新案です。作画が揃うまで反映できません');
 return validateSourcePatch(project,candidate.prepared.expected,candidate.patch);
}
