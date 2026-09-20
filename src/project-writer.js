// One short save boundary per mounted workspace. Network/model work stays outside.
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const canBootstrapWork=(before,after)=>before===after||(before==null&&after!=null);
function mergeItems(base,next,latest,key){
 const ids=new Set([...base,...next].map(x=>x.id)),result=[...latest];
 for(const id of ids){const before=base.find(x=>x.id===id),after=next.find(x=>x.id===id);if(equal(before,after))continue;
  const index=result.findIndex(x=>x.id===id),now=result[index];
  if(!equal(now,before)&&!equal(now,after))throw Error(`保存中に ${key} の対象が変わりました`);
  if(after===undefined){if(index>=0)result.splice(index,1);}else if(index<0)result.push(after);else result[index]=after;
 }return result;
}
export function mergeProjectChanges(base,next,latest){
 if(base.workId!==latest.workId||!canBootstrapWork(base.workId,next.workId))throw Error('対象作品が変わりました');
 if(next.contentToken!==base.contentToken)throw Error('操作の基準版が古くなりました');
 if(next.revision!==base.revision)throw Error('操作の保存版が古くなりました');
 const result={...latest};
 for(const key of new Set([...Object.keys(base),...Object.keys(next)])){
  if(['contentToken','revision'].includes(key)||equal(base[key],next[key]))continue;
  if(['jobs','artworks'].includes(key)&&Array.isArray(base[key])&&Array.isArray(next[key])&&Array.isArray(latest[key]))result[key]=mergeItems(base[key],next[key],latest[key],key);
  else {if(!equal(base[key],latest[key])&&!equal(next[key],latest[key]))throw Error('保存中に作品が変わりました。操作を確認してください');if(key in next)result[key]=next[key];else delete result[key];}
 }
 return result;
}
export function createProjectWriter({current,save,accept}){
 let tail=Promise.resolve();
 return {
  commit(update){const base=current();return this.exclusive(async()=>{const latest=current(),next=typeof update==='function'?update(latest):mergeProjectChanges(base,update,latest);const saved=await save({...next,revision:(latest.revision??0)+1});if(!canBootstrapWork(latest.workId,current().workId))throw Error('対象作品が変わりました');accept(saved);return saved;});},
  exclusive(action){const operation=tail.then(action);tail=operation.catch(()=>{});return operation;},
  flush(){return tail;},
 };
}
