import {defaultLettering} from './lettering.js';
import {sourceResolver,tokenizeSnapshot,legacyPanelRefs,refKey,covers,intersect} from './source-refs.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function sealSnapshots(snapshots){
 for(const snapshot of snapshots)for(const scene of snapshot.scenes??[]){
  // TextEncoder would silently repair lone surrogates; reject before hashing.
  sourceResolver([{...snapshot,scenes:[scene]}]);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(scene.text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(scene.sourceHash&&scene.sourceHash!==hash)throw Error('保存済み原文のhashが一致しません');scene.sourceHash=hash;
 }
}
export function migrateSourceApplication(project){
 const resolve=sourceResolver(project.snapshots),diagnostics=[];
 function state(value){
  for(const panel of value.panels??[]){
   if(panel.sourceRefs){panel.sourceRefs.forEach(resolve);continue;}
   const original=structuredClone(panel);
   try {const refs=legacyPanelRefs(panel,project.snapshots);if(!refs.length&&!panel.manual)throw Error('旧コマの原文を特定できません');
    panel.lettering??=defaultLettering(panel);panel.sourceRefs=refs;panel.contextRefs=[];
    if(panel.lettering)for(const [i,box] of panel.lettering.boxes.entries()){
     const refs=legacyPanelRefs({...panel,sourceRefs:undefined,unitIds:[box.unit_id]},project.snapshots);
     box.sourceRefs=refs;box.id=`box:${panel.id}:${box.id??i}`;
    }
   }catch(e){for(const key of Object.keys(panel))delete panel[key];Object.assign(panel,original);diagnostics.push({panelId:panel.id,reason:e.message});}
  }
  for(const entry of value.history??[])state(entry);for(const entry of value.editRedo??[])state(entry);if(value.after)state(value.after);
 }
 state(project);
 if(!project.sourceApplication){
  const units=[],seen=new Set();
  // Never mark plans or partial shared paragraphs as applied.
  for(const panel of project.panels){if(!panel.sourceRefs)continue;
   const snapshot=project.snapshots.find(s=>s.id===panel.snapshotId);if(!snapshot)continue;
   for(const unit of tokenizeSnapshot(snapshot).filter(u=>panel.sourceRefs.some(r=>intersect(r,u.source)))){
    const k=refKey(unit.source);if(seen.has(k))continue;seen.add(k);
    const linked=project.panels.filter(p=>(p.sourceRefs??[]).some(r=>intersect(r,unit.source)));
    if(!linked.every(p=>p.image&&p.lettering))continue;
    const text=linked.flatMap(p=>p.lettering.boxes.flatMap(b=>b.sourceRefs??[])).filter(r=>intersect(r,unit.source));
    if(!covers([unit.source],linked.flatMap(p=>p.sourceRefs))||!covers([unit.source],text,{exact:true}))continue;
    units.push({id:`legacy:${k}`,source:unit.source,requiredText:[unit.source]});
   }
  }
  project.sourceApplication={version:1,units};
 }
 project.sourceDiagnostics=diagnostics;return project;
}
export function validateApplication(project,units=project.sourceApplication?.units??[]){
 const resolve=sourceResolver(project.snapshots),seen=new Set(),consumed=[];
 for(const unit of units){
  if(!unit.id||seen.has(unit.id)||!Array.isArray(unit.requiredText))throw Error('反映原稿の識別子が不正です');seen.add(unit.id);resolve(unit.source);
  if(consumed.some(r=>intersect(r,unit.source)))throw Error('同じ原文を重複して反映できません');consumed.push(unit.source);
  for(const ref of unit.requiredText){resolve(ref);if(!covers([ref],[unit.source]))throw Error('掲載する台詞が原稿単位の外にあります');}
  const linked=project.panels.filter(p=>(p.sourceRefs??[]).some(r=>intersect(r,unit.source)));
  if(!linked.length||linked.some(p=>!p.image)||!covers([unit.source],linked.flatMap(p=>p.sourceRefs)))throw Error('原稿に対応する作画が未完成です');
  const boxes=linked.flatMap(p=>p.lettering?.boxes??[]),refs=boxes.flatMap(b=>b.sourceRefs??[]).filter(r=>intersect(r,unit.source));
  if(!covers(unit.requiredText,refs,{exact:true}))throw Error('掲載する台詞の欠落・重複があります');
  const expected=unit.requiredText.map(resolve).join(''),actual=refs.map(resolve).join('');if(expected!==actual)throw Error('掲載する台詞の順序が不正です');
 }
 return true;
}
export function buildAffectedScope(project,sourceEdits){
 const ids=new Set(sourceEdits.flatMap(e=>e.oldUnitIds)),units=(project.sourceApplication?.units??[]).filter(u=>ids.has(u.id));
 const refs=units.map(u=>u.source),contentPanelIds=project.panels.filter(p=>(p.sourceRefs??[]).some(r=>refs.some(ref=>intersect(ref,r)))).map(p=>p.id);
 const indices=(project.layout?.pages??[]).flatMap((p,i)=>p.slots.some(s=>contentPanelIds.includes(s.panelId))?[i]:[]),layoutIntervals=[];
 for(const i of indices){const last=layoutIntervals.at(-1);if(last&&last.end===i)last.end=i+1;else layoutIntervals.push({start:i,end:i+1});}
 return {contentPanelIds,contextRefs:project.panels.filter(p=>contentPanelIds.includes(p.id)).flatMap(p=>p.contextRefs??[]),layoutIntervals};
}
export function validateSourcePatch(project,expected,patch){
 if(project.contentToken&&project.contentToken!==expected.baseContentToken)throw Error('古い基準の原稿反映です');
 if(project.active!==expected.targetSnapshotId)throw Error('対象原稿が変わりました');
 if(!same(patch.sourceApplication,{version:1,units:expected.afterUnits}))throw Error('選択外の原文を反映する案です');
 const affected=buildAffectedScope(project,expected.sourceEdits),allowed=new Set(affected.contentPanelIds),old=new Map(project.panels.map(p=>[p.id,p]));
 for(const panel of project.panels){const next=patch.panels.find(p=>p.id===panel.id);
  if(!allowed.has(panel.id)&&!same(panel,next))throw Error('対象外のコマは変更できません');
  if(allowed.has(panel.id)&&!next&&(panel.manual||(panel.sourceRefs??[]).some(r=>expected.retainRefs.some(keep=>intersect(keep,r)))))throw Error('残す原文または手動要素のあるコマは削除できません');
  for(const box of panel.lettering?.boxes??[])if(box.locked&&!same(box,next?.lettering?.boxes.find(b=>b.id===box.id)))throw Error('固定した文字枠は変更できません');
 }
 for(const panel of patch.panels){if(old.has(panel.id)&&!same(old.get(panel.id).sourceRefs,panel.sourceRefs))throw Error('内容を変更したコマには新IDが必要です');}
 validateApplication({...project,...patch});return patch;
}

export async function upgradeSourceProject(project){
 const next=structuredClone(project);await sealSnapshots(next.snapshots);migrateSourceApplication(next);next.version=5;return next;
}
