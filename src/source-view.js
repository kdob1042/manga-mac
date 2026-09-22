import {buildChangeSet,highlightSourceChange} from './source-diff.js';
import {sourceResolver,tokenizeSnapshot,refKey} from './source-refs.js';

// Presentation only: all states and selectable operations come from the common diff.
export function sourceView(project,replanApplied=false){
 const changes=buildChangeSet(project,project.active,replanApplied?{replanApplied:true}:{}),resolve=sourceResolver(project.snapshots);
 const target=project.snapshots.find(s=>s.id===project.active),units=tokenizeSnapshot(target);
 const old=new Map(project.sourceApplication.units.map(u=>[u.id,u])),covered=new Set();
 const rows=changes.blocks.map(block=>{
  const oldRefs=block.oldUnitIds.map(id=>old.get(id).source);
  block.newRefs.forEach(ref=>covered.add(refKey(ref)));
  return {type:'change',at:block.targetStart,block,oldRefs,highlight:highlightSourceChange(project.snapshots,oldRefs,block.newRefs)};
 });
 for(const [at,unit] of units.entries())if(!covered.has(refKey(unit.source)))rows.push({type:'applied',at,ref:unit.source});
 // A move is one selectable operation. Its source location is an annotation only.
 for(const block of changes.blocks.filter(b=>b.kind==='move')){
  const sequence=project.sourceApplication.units,begin=block.moveStart;
  let at=0;
  for(let i=begin-1;i>=0;i--){const u=sequence[i],matches=units.map((t,j)=>({t,j})).filter(({t})=>t.source.sceneId===u.source.sceneId&&t.text===resolve(u.source));if(matches.length===1){at=matches[0].j+1;break;}}
  rows.push({type:'move-origin',at,block,oldRefs:block.oldUnitIds.map(id=>old.get(id).source)});
 }
 rows.sort((a,b)=>a.at-b.at||(a.type==='applied'?1:0)-(b.type==='applied'?1:0));
 return {changes,rows,resolve};
}
export function toggleSourceGroup(changes,selected,id){
 const block=changes.blocks.find(b=>b.id===id);if(!block)throw Error('差分が更新されました');
 const group=changes.blocks.filter(b=>b.groupId===block.groupId).map(b=>b.id),next=new Set(selected);
 if(group.every(id=>next.has(id)))group.forEach(id=>next.delete(id));else group.forEach(id=>next.add(id));
 return changes.blocks.filter(b=>next.has(b.id)).map(b=>b.id);
}
export function sourceSelection(project,changes,ids){
 const current=buildChangeSet(project,project.active,changes.budget);
 if(current.id!==changes.id||JSON.stringify(current.blocks)!==JSON.stringify(changes.blocks))throw Error('原稿または漫画が変わりました。選択し直してください');
 if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!current.blocks.some(b=>b.id===id)))throw Error('反映する差分を選択してください');
 for(const b of current.blocks)if(ids.includes(b.id)&&current.blocks.some(other=>other.groupId===b.groupId&&!ids.includes(other.id)))throw Error('関連する差分をまとめて選択してください');
 return {...(current.budget.replanApplied?{budget:current.budget}:{}),changeSetId:current.id,selectedBlockIds:[...ids],baseContentToken:current.baseContentToken,targetSnapshotId:current.targetSnapshotId};
}
