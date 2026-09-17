// Process-wide limits shared by manual and queued entry points. No job store here.
const resources=new Map();
const permits=new WeakMap();
export const holdsResource=(permit,key)=>permit&&permits.get(permit)===key;
export async function withResource(key,limit,action,{cancelled=()=>false,waiting=()=>{}}={}){
 if(!Number.isInteger(limit)||limit<1||limit>4)throw Error('実行数が不正です');
 let resource=resources.get(key);if(!resource){resource={running:0,limit,queue:[]};resources.set(key,resource);}
 resource.limit=Math.min(resource.limit,limit);
 const drain=()=>{while(resource.queue.length&&resource.running<resource.limit){resource.running++;resource.queue.shift()();}};
 if(resource.running>=resource.limit)waiting();
 await new Promise(resolve=>{resource.queue.push(resolve);drain();});
 const permit={};permits.set(permit,key);
 try {if(cancelled())throw Error('待機中の処理を停止しました');return await action(permit);}
 finally {permits.delete(permit);resource.running--;drain();if(!resource.running&&!resource.queue.length)resources.delete(key);}
}
export function createRangeScheduler(){
 const active=new Map(),waiting=[];
 const drain=()=>{for(let i=0;i<waiting.length;){const item=waiting[i];if(item.cancelled()){waiting.splice(i,1);item.reject(Error('待機中の処理を停止しました'));continue;}
  if([...active.values()].some(keys=>item.keys.some(key=>keys.includes(key)))){i++;continue;}
  waiting.splice(i,1);active.set(item.id,item.keys);item.resolve();
 }};
 return {acquire(id,keys,cancelled=()=>false){if(active.has(id)||waiting.some(x=>x.id===id))throw Error('同じ処理を二重開始できません');return new Promise((resolve,reject)=>{waiting.push({id,keys,cancelled,resolve,reject});drain();});},release(id){active.delete(id);drain();},wake:drain};
}
