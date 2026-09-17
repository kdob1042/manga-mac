// Persist Unicode scalar offsets, never JS UTF-16 indices or Rust byte offsets.
export function codePointMap(text) {
  if(typeof text!=='string'||!text.isWellFormed())throw Error('原文のUnicodeが不正です');
  const positions=[0];let offset=0;for(const char of text){offset+=char.length;positions.push(offset);}return positions;
}
export function refKey(r){return JSON.stringify([r.snapshotId,r.sceneId,r.startCp,r.endCp]);}
export function sourceResolver(snapshots) {
  const scenes=new Map();
  for(const snapshot of snapshots??[])for(const scene of snapshot.scenes??[]){const key=JSON.stringify([snapshot.id,scene.id]);if(scenes.has(key))throw Error('原稿版・場面が重複しています');scenes.set(key,{text:scene.text,map:codePointMap(scene.text)});}
  return ref=>{
    const scene=scenes.get(JSON.stringify([ref?.snapshotId,ref?.sceneId]));
    if(!scene||!Number.isSafeInteger(ref.startCp)||!Number.isSafeInteger(ref.endCp)||ref.startCp<0||ref.startCp>=ref.endCp||ref.endCp>=scene.map.length)throw Error('原稿範囲の版・場面・位置が不正です');
    return scene.text.slice(scene.map[ref.startCp],scene.map[ref.endCp]);
  };
}
export function resolveSourceRef(snapshots,ref){return sourceResolver(snapshots)(ref);}
export function tokenizeSnapshot(snapshot){
  const units=[];
  for(const scene of snapshot.scenes??[]){
    const map=codePointMap(scene.text),cp=new Map(map.map((v,i)=>[v,i]));let start=0,index=0;
    const add=end=>{const text=scene.text.slice(start,end);if(text.trim()&&!/^\s*#/.test(text))units.push({legacyId:`${scene.id}:u${index}`,text,source:{snapshotId:snapshot.id,sceneId:scene.id,startCp:cp.get(start),endCp:cp.get(end)}});index++;};
    for(const match of scene.text.matchAll(/\n\s*\n/g)){add(match.index);start=match.index+match[0].length;}add(scene.text.length);
  }return units;
}
export function legacyPanelRefs(panel,snapshots){
  if(panel.sourceRefs)return panel.sourceRefs;
  const snapshot=snapshots.find(s=>s.id===panel.snapshotId);if(!snapshot)throw Error('旧コマの原稿版がありません');
  const units=new Map(tokenizeSnapshot(snapshot).filter(u=>u.source.sceneId===panel.sceneId).map(u=>[u.legacyId,u.source]));
  return (panel.unitIds??[]).map(id=>{const ref=units.get(id);if(!ref)throw Error('旧コマの原文を特定できません');return ref;});
}
export function intersect(a,b){return a.snapshotId===b.snapshotId&&a.sceneId===b.sceneId&&a.startCp<b.endCp&&b.startCp<a.endCp;}
export function covers(expected,actual,{exact=false}={}){
  for(const target of expected){
    const ranges=actual.filter(r=>intersect(target,r)).map(r=>[Math.max(r.startCp,target.startCp),Math.min(r.endCp,target.endCp)]).sort((a,b)=>a[0]-b[0]);let end=target.startCp;
    for(const [a,b] of ranges){if(a>end||(exact&&a<end))return false;end=Math.max(end,b);}if(end!==target.endCp)return false;
  }
  return !exact||actual.every(r=>covers([r],expected));
}
export function sourcePages(project){const index=new Map();for(const page of project.layout?.pages??[])for(const slot of page.slots)if(slot.panelId)index.set(slot.panelId,page.id);return ref=>project.panels.filter(p=>(p.sourceRefs??legacyPanelRefs(p,project.snapshots)).some(r=>intersect(r,ref))).map(p=>({panelId:p.id,pageId:index.get(p.id)??null}));}
export function textForRefs(refs,snapshots,localizations=null){
 const resolve=sourceResolver(snapshots);let text='',previous=null;
 for(const ref of refs){let piece=resolve(ref);
  if(localizations){const localization=(Array.isArray(localizations)?localizations:[localizations]).find(l=>l.snapshot_id===ref.snapshotId&&l.locale==='en'),snapshot=snapshots.find(s=>s.id===ref.snapshotId),unit=tokenizeSnapshot(snapshot).find(u=>refKey(u.source)===refKey(ref));
   const translated=localization?.units.find(u=>u.id===unit?.legacyId);if(!translated)throw Error('この原文範囲の英訳は未更新です');piece=translated.text;}
  if(previous&&!(previous.snapshotId===ref.snapshotId&&previous.sceneId===ref.sceneId&&previous.endCp===ref.startCp))text+='\n\n';text+=piece;previous=ref;
 }return text;
}
