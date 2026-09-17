// Search normalization never mutates immutable source metadata.
export const tagKey = value => value.normalize('NFKC').trim().toLowerCase();
export function sceneTags(snapshot, sceneId) {
 const scene=snapshot?.scenes?.find(s=>s.id===sceneId);
 if(!scene)return [];
 const tags=scene.tags ?? snapshot.manifest?.scenes?.find(s=>s.id===sceneId)?.tags ?? [];
 const seen=new Set();
 return tags.filter(tag=>{const key=tagKey(tag);if(seen.has(key))return false;seen.add(key);return true;});
}
export function tagOptions(snapshot){
 const seen=new Set(),result=[];
 for(const scene of snapshot?.scenes??[])for(const tag of sceneTags(snapshot,scene.id)){
  const key=tagKey(tag);if(!seen.has(key)){seen.add(key);result.push({key,label:tag});}
 }
 return result;
}
export function matchingScenes(snapshot,selected=[],mode='any'){
 if(!['any','all'].includes(mode))throw Error('タグの一致条件が不正です');
 const keys=[...new Set(selected.map(tagKey))];
 return (snapshot?.scenes??[]).filter(scene=>{
  const tags=new Set(sceneTags(snapshot,scene.id).map(tagKey));
  return !keys.length||(mode==='all'?keys.every(k=>tags.has(k)):keys.some(k=>tags.has(k)));
 }).map(scene=>scene.id);
}
export const rowSceneIds=row=>[...new Set((row.type==='applied'?[row.ref]:[...row.oldRefs,...row.block.newRefs]).map(r=>r.sceneId))];
// Dependency expansion is returned for explicit confirmation, never auto-applied.
export function tagBlockSelection(changes,rows,sceneIds,pending=[]){
 const wanted=new Set(sceneIds),groups=new Set();
 for(const row of rows)if(row.block&&rowSceneIds(row).some(id=>wanted.has(id)))groups.add(row.block.groupId);
 const blocked=new Set(changes.blocks.filter(b=>pending.includes(b.id)).map(b=>b.groupId));
 const blocks=changes.blocks.filter(b=>groups.has(b.groupId)&&!blocked.has(b.groupId));
 const selected=new Set(blocks.map(b=>b.id));
 const additional=[...new Set(rows.filter(r=>r.block&&selected.has(r.block.id)).flatMap(rowSceneIds).filter(id=>!wanted.has(id)))];
 return {ids:blocks.map(b=>b.id),additional};
}
