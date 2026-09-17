import {initialLayout} from './layout.js';
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
   try {const refs=legacyPanelRefs(panel,project.snapshots);if(!Array.isArray(panel.unitIds)&&!panel.manual)throw Error('旧コマの原文を特定できません');
    if(panel.image)panel.lettering??=defaultLettering(panel);panel.sourceRefs=refs;panel.contextRefs=[];
    if(panel.lettering)for(const [i,box] of panel.lettering.boxes.entries()){
     const refs=legacyPanelRefs({...panel,sourceRefs:undefined,unitIds:[box.unit_id]},project.snapshots);
     box.sourceRefs=refs;box.id=`box:${panel.id}:${box.id??i}`;
    }
   }catch(e){for(const key of Object.keys(panel))delete panel[key];Object.assign(panel,original);diagnostics.push({panelId:panel.id,reason:e.message});}
  }
  if(Array.isArray(value.panels)&&!value.sourceApplication){
   const layout=value.layout??initialLayout(value.panels),placed=layout.pages.flatMap(page=>page.slots.map(slot=>slot.panelId)),ordered=placed.map(id=>value.panels.find(p=>p.id===id)).filter(Boolean);
   const units=[],seen=new Set();
   for(const panel of ordered)for(const ref of panel.sourceRefs??[]){
    const snapshot=project.snapshots.find(s=>s.id===ref.snapshotId);if(!snapshot)continue;
    for(const unit of tokenizeSnapshot(snapshot).filter(u=>intersect(ref,u.source))){
     const k=refKey(unit.source);if(seen.has(k))continue;seen.add(k);
     const linked=value.panels.filter(p=>(p.sourceRefs??[]).some(r=>intersect(r,unit.source)));
     if(!linked.every(p=>p.image&&p.lettering&&placed.filter(id=>id===p.id).length===1))continue;
     const text=ordered.filter(p=>linked.includes(p)).flatMap(p=>p.lettering.boxes.flatMap(b=>b.sourceRefs??[])).filter(r=>intersect(r,unit.source));
     if(!covers([unit.source],linked.flatMap(p=>p.sourceRefs))||!covers([unit.source],text,{exact:true})||!sameRefOrder([unit.source],text))continue;
     units.push({id:`legacy:${k}`,source:unit.source,requiredText:[unit.source]});
    }
   }
   value.sourceApplication={version:1,units};
   try{validateApplication({...project,...value,layout});}catch(e){value.sourceApplication.units=[];diagnostics.push({reason:e.message});}
  }
  for(const entry of value.history??[])state(entry);for(const entry of value.editRedo??[])state(entry);if(value.after)state(value.after);
 }
 state(project);
 project.sourceDiagnostics=diagnostics;return project;
}
export function validateApplication(project,units=project.sourceApplication?.units??[]){
 const resolve=sourceResolver(project.snapshots),seen=new Set(),consumed=[];
 const placed=(project.layout?.pages??[]).flatMap(page=>page.slots.map(slot=>slot.panelId)).filter(Boolean);
 const ordered=placed.map(id=>project.panels.find(p=>p.id===id)).filter(Boolean);
 for(const unit of units){
  if(!unit.id||seen.has(unit.id)||!Array.isArray(unit.requiredText))throw Error('反映原稿の識別子が不正です');seen.add(unit.id);resolve(unit.source);
  if(consumed.some(r=>intersect(r,unit.source)))throw Error('同じ原文を重複して反映できません');consumed.push(unit.source);
  for(const ref of unit.requiredText){resolve(ref);if(!covers([ref],[unit.source]))throw Error('掲載する台詞が原稿単位の外にあります');}
  const linked=ordered.filter(p=>(p.sourceRefs??[]).some(r=>intersect(r,unit.source)));
  if(project.panels.some(p=>(p.sourceRefs??[]).some(r=>intersect(r,unit.source))&&placed.filter(id=>id===p.id).length!==1))throw Error('原稿に対応するコマの配置が欠落・重複しています');
  if(!linked.length||linked.some(p=>!p.image)||!covers([unit.source],linked.flatMap(p=>p.sourceRefs)))throw Error('原稿に対応する作画が未完成です');
  const boxes=linked.flatMap(p=>p.lettering?.boxes??[]),refs=boxes.flatMap(b=>b.sourceRefs??[]).filter(r=>intersect(r,unit.source));
  if(!covers(unit.requiredText,refs,{exact:true}))throw Error('掲載する台詞の欠落・重複があります');
  if(!sameRefOrder(unit.requiredText,refs))throw Error('掲載する台詞の順序が不正です');
 }
 const required=units.flatMap(u=>u.requiredText),shown=ordered.flatMap(p=>p.lettering?.boxes??[]).flatMap(b=>b.sourceRefs??[]).filter(r=>required.some(e=>intersect(e,r)));
 if(!sameRefOrder(required,shown))throw Error('掲載する台詞の読書順が不正です');
 return true;
}
function sameRefOrder(expected,actual){
 let i=0,j=0,a=expected[0]?.startCp,b=actual[0]?.startCp;
 while(i<expected.length&&j<actual.length){const e=expected[i],r=actual[j];if(e.snapshotId!==r.snapshotId||e.sceneId!==r.sceneId||a!==b)return false;
 const end=Math.min(e.endCp,r.endCp);a=end;b=end;if(end===e.endCp){i++;a=expected[i]?.startCp;}if(end===r.endCp){j++;b=actual[j]?.startCp;}}
 return i===expected.length&&j===actual.length;
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
  if(allowed.has(panel.id)&&!next){
   const retained=(panel.sourceRefs??[]).flatMap(r=>expected.retainRefs.filter(keep=>intersect(keep,r)).map(keep=>({...r,startCp:Math.max(r.startCp,keep.startCp),endCp:Math.min(r.endCp,keep.endCp)})));
   const replacements=patch.panels.filter(p=>p.replacesPanelIds?.includes(panel.id)).flatMap(p=>p.sourceRefs??[]);
   if(panel.manual||!covers(retained,replacements))throw Error('残す原文または手動要素のあるコマは削除できません');
  }
  for(const box of panel.lettering?.boxes??[])if(box.locked&&!same(box,next?.lettering?.boxes.find(b=>b.id===box.id)))throw Error('固定した文字枠は変更できません');
 }
 for(const panel of patch.panels){if(old.has(panel.id)&&!same(old.get(panel.id).sourceRefs,panel.sourceRefs))throw Error('内容を変更したコマには新IDが必要です');}
 validateApplication({...project,...patch});return patch;
}

export async function upgradeSourceProject(project){
 const next=structuredClone(project);await sealSnapshots(next.snapshots);migrateSourceApplication(next);next.version=5;return next;
}
