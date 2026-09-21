import {diffArrays} from 'diff';
import {sourceResolver,tokenizeSnapshot} from './source-refs.js';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const key=u=>JSON.stringify([u.source.sceneId,u.text]);
const frequencies=a=>{const map=new Map();for(const u of a)map.set(key(u),(map.get(key(u))??0)+1);return map;};
export function buildChangeSet(project,targetSnapshotId=project.active,budget={}){
 const target=project.snapshots.find(s=>s.id===targetSnapshotId);if(!target)throw Error('対象原稿がありません');
 const resolve=sourceResolver(project.snapshots),old=(project.sourceApplication?.units??[]).map(u=>({...u,text:resolve(u.source)})),fresh=tokenizeSnapshot(target);
 const oldCount=frequencies(old),newCount=frequencies(fresh),oldKeys=old.map(key),newKeys=fresh.map(key);
 if(typeof project.contentToken!=='string'||!project.contentToken||typeof project.workId!=='string'||!project.workId)throw Error('保存された作品の基準tokenがありません');
 const token=project.contentToken;
 const id=JSON.stringify([project.workId,token,targetSnapshotId]);
 const result={id,workId:project.workId,targetSnapshotId,baseContentToken:token,budget,blocks:[]};
 if(equal(oldKeys,newKeys))return result;
 const coarse=old.length+fresh.length>(budget.maxUnits??4000);
 const diff=coarse?undefined:diffArrays(oldKeys,newKeys,{timeout:budget.timeout??100,maxEditLength:budget.maxEditLength??2000});
 // Only globally unique matches anchor changed regions. Repeated text inside a
 // changed region is not evidence for which occurrence/illustration survived.
 const anchors=[];let oi=0,ni=0;
 if(diff)for(const part of diff){if(part.added)ni+=part.count;else if(part.removed)oi+=part.count;else {for(let i=0;i<part.count;i++)if(oldCount.get(oldKeys[oi+i])===1&&newCount.get(newKeys[ni+i])===1)anchors.push([oi+i,ni+i]);oi+=part.count;ni+=part.count;}}
 anchors.push([old.length,fresh.length]);let os=0,ns=0;
 const ranges=[];
 if(diff)for(const [oe,ne] of anchors){ranges.push([os,oe,ns,ne]);os=oe+1;ns=ne+1;}
 else ranges.push(...coarseSceneRanges(old,fresh));
 if(!old.length){ranges.length=0;for(let i=0;i<fresh.length;i++)ranges.push([0,0,i,i+1]);}
 for(const [os,oe,ns,ne] of ranges){const before=old.slice(os,oe),after=fresh.slice(ns,ne);
  if(!equal(before.map(key),after.map(key))){const index=result.blocks.length;
   result.blocks.push({id:`${id}:${index}`,groupId:`${id}:group:${index}`,kind:before.length?(after.length?'replace':'delete'):'insert',oldUnitIds:before.map(u=>u.id),newRefs:after.map(u=>u.source),beforeUnitId:os>0?old[os-1].id:null,afterUnitId:oe<old.length?old[oe].id:null,start:os,end:oe,targetStart:ns,...(!diff?{diagnostic:'coarse_diff'}:before.concat(after).some(u=>(oldCount.get(key(u))??0)>1||(newCount.get(key(u))??0)>1)?{diagnostic:'ambiguous_alignment'}:{})});
  }
 }
 // An unambiguous move is one operation; its deletion cannot be selected alone.
 for(const insertion of result.blocks.filter(b=>b.kind==='insert')){
  const texts=insertion.newRefs.map(source=>({source,text:resolve(source)}));
  if(texts.some(u=>oldCount.get(key(u))!==1||newCount.get(key(u))!==1))continue;
  const deletion=result.blocks.find(b=>b.kind==='delete'&&equal(b.oldUnitIds.map(id=>key(old.find(u=>u.id===id))),texts.map(key)));
  if(deletion){insertion.kind='move';insertion.oldUnitIds=deletion.oldUnitIds;insertion.moveStart=deletion.start;insertion.moveEnd=deletion.end;deletion.merged=true;}
 }
 result.blocks=result.blocks.filter(b=>!b.merged);return result;
}
export function buildExpectedApplication(project,changeset,selectedBlockIds){
 const current=buildChangeSet(project,changeset.targetSnapshotId,changeset.budget);
 if(current.id!==changeset.id||!equal(current.blocks,changeset.blocks))throw Error('原稿または漫画が変わりました。差分を選び直してください');
 if(!Array.isArray(selectedBlockIds)||new Set(selectedBlockIds).size!==selectedBlockIds.length||selectedBlockIds.some(id=>!current.blocks.some(b=>b.id===id)))throw Error('選択した差分が不正です');
 const selected=current.blocks.filter(b=>selectedBlockIds.includes(b.id)),units=project.sourceApplication?.units??[],deleted=new Set(selected.flatMap(b=>b.oldUnitIds));
 const additions=new Map();const byId=new Map(units.map(u=>[u.id,u]));
 for(const b of selected){const entries=b.kind==='move'?b.oldUnitIds.map(id=>byId.get(id)):b.newRefs.map((source,i)=>({id:`source:${b.id}:${i}`,source,requiredText:[source]}));const at=additions.get(b.start)??[];at.push({order:b.targetStart,entries});additions.set(b.start,at);}
 const afterUnits=[];for(let i=0;i<=units.length;i++){for(const addition of (additions.get(i)??[]).sort((a,b)=>a.order-b.order))afterUnits.push(...addition.entries);if(i<units.length&&!deleted.has(units[i].id))afterUnits.push(units[i]);}
 if(new Set(afterUnits.map(u=>u.id)).size!==afterUnits.length)throw Error('反映する原稿が重複しています');
 return {changeSetId:current.id,targetSnapshotId:current.targetSnapshotId,baseContentToken:current.baseContentToken,afterUnits,sourceEdits:selected,retainRefs:units.filter(u=>!deleted.has(u.id)).map(u=>u.source)};
}

// Highlighting never changes the selectable block or its immutable source refs.
export function highlightSourceChange(snapshots,oldRefs,newRefs,budget={}){
 const resolve=sourceResolver(snapshots);
 const tokens=refs=>refs.flatMap(ref=>[...resolve(ref)].map((text,i)=>({text,ref:{...ref,startCp:ref.startCp+i,endCp:ref.startCp+i+1}})));
 const old=tokens(oldRefs),fresh=tokens(newRefs),oldFlags=old.map(()=>true),newFlags=fresh.map(()=>true);
 const parts=old.length+fresh.length>(budget.maxCodePoints??20000)?undefined:diffArrays(old.map(t=>t.text),fresh.map(t=>t.text),{timeout:budget.timeout??50,maxEditLength:budget.maxEditLength??2000});
 let a=0,b=0;if(parts)for(const part of parts){if(part.removed)a+=part.count;else if(part.added)b+=part.count;else {for(let i=0;i<part.count;i++){oldFlags[a+i]=false;newFlags[b+i]=false;}a+=part.count;b+=part.count;}}
 const ranges=(list,flags)=>{const result=[];for(const [i,token] of list.entries()){const previous=result.at(-1);if(previous&&previous.changed===flags[i]&&previous.ref.snapshotId===token.ref.snapshotId&&previous.ref.sceneId===token.ref.sceneId&&previous.ref.endCp===token.ref.startCp)previous.ref.endCp=token.ref.endCp;else result.push({ref:{...token.ref},changed:flags[i]});}return result;};
 return {old:ranges(old,oldFlags),new:ranges(fresh,newFlags),coarse:!parts};
}

// Bound the expensive paragraph diff without turning one large scene into a
// whole-book rewrite. Stable scene IDs delimit coarse regions, not text hashes.
function coarseSceneRanges(old,fresh){
 const runs=units=>{const out=[];for(const [i,u] of units.entries()){const last=out.at(-1);if(last?.id===u.source.sceneId)last.end=i+1;else out.push({id:u.source.sceneId,start:i,end:i+1});}return out;};
 const a=runs(old),b=runs(fresh);
 if(a.length+b.length>10000)throw Error('原稿の場面数が多いため差分を処理できません。保存済みの漫画は変更していません');
 const parts=diffArrays(a.map(r=>r.id),b.map(r=>r.id),{timeout:100,maxEditLength:10000});
 if(!parts)throw Error('原稿の場面対応を時間内に確認できません。保存済みの漫画は変更していません');
 const ranges=[];let ai=0,bi=0,startA=0,startB=0;
 const pos=(runs,i,length)=>runs[i]?.start??length;
 const flush=()=>{const x=pos(a,ai,old.length),y=pos(b,bi,fresh.length);if(x!==startA||y!==startB)ranges.push([startA,x,startB,y]);startA=x;startB=y;};
 for(const part of parts){if(part.removed)ai+=part.count;else if(part.added)bi+=part.count;else {flush();for(let i=0;i<part.count;i++){ai++;bi++;flush();}}}flush();return ranges;
}
