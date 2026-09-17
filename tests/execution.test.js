import {test} from 'node:test';import assert from 'node:assert/strict';
import {withResource,createRangeScheduler,holdsResource} from '../src/execution.js';
import {createProjectWriter} from '../src/project-writer.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
test('shared resource limits include other entry points and reductions drain safely',async()=>{
 const a=deferred(),b=deferred(),c=deferred(),started=[];let active=0,max=0;
 const run=(id,limit,gate)=>withResource('connection',limit,async permit=>{assert.ok(holdsResource(permit,'connection'));started.push(id);max=Math.max(max,++active);await gate.promise;active--;});
 const A=run('A',2,a),B=run('B',2,b);await tick();assert.deepEqual(started,['A','B']);const C=run('C',1,c);a.resolve();await A;await tick();assert.equal(active,1);assert.deepEqual(started,['A','B']);b.resolve();await B;await tick();assert.deepEqual(started,['A','B','C']);c.resolve();await C;assert.equal(max,2);
});
test('cancelled GPU waiter never submits and other queued work continues',async()=>{
 const gate=deferred();let cancelled=false,sends=0;const first=withResource('gpu',1,()=>gate.promise);await tick();const stopped=withResource('gpu',1,()=>sends++,{cancelled:()=>cancelled});const other=withResource('gpu',1,()=>sends++);cancelled=true;gate.resolve();await first;await assert.rejects(stopped,/停止/);await other;assert.equal(sends,1);
});
test('range dependencies serialize conflicts while independent runs start and stop separately',async()=>{
 const s=createRangeScheduler();await s.acquire('A',['page:1','context:p']);let same=false,stopped=false;const B=s.acquire('B',['context:p'],()=>stopped).then(()=>same=true);await s.acquire('C',['page:3']);await tick();assert.equal(same,false);s.release('C');assert.equal(same,false);stopped=true;s.wake();await assert.rejects(B,/停止/);s.release('A');await s.acquire('D',['context:p']);s.release('D');
});
test('writer preserves inverse job completions and rejects stale same-token objects, switch and failed save',async()=>{
 let p={workId:'w',contentToken:'base',revision:0,jobs:[],artworks:[],panels:[{id:'C'}]},fail=false;const gate=deferred();let first=true;
 const writer=createProjectWriter({current:()=>p,accept:value=>p=value,save:async value=>{if(first){first=false;await gate.promise;}if(fail)throw Error('disk');return value;}});
 const stale=structuredClone(p);const A=writer.commit(latest=>({...latest,jobs:[...latest.jobs,{id:'A',status:'complete'}]}));const B=writer.commit(latest=>({...latest,jobs:[...latest.jobs,{id:'B',status:'complete'}]}));gate.resolve();await Promise.all([A,B]);assert.deepEqual(p.jobs.map(j=>j.id),['A','B']);assert.deepEqual(p.panels,[{id:'C'}]);await assert.rejects(writer.commit({...stale,jobs:[{id:'old'}]}),/古く/);assert.equal(p.jobs.length,2);
 fail=true;const before=structuredClone(p);await assert.rejects(writer.commit(latest=>({...latest,jobs:[]})),/disk/);assert.deepEqual(p,before);fail=false;
 const late=structuredClone(p);p={...p,workId:'other'};await assert.rejects(writer.commit(late),/作品/);assert.equal(p.workId,'other');
});
