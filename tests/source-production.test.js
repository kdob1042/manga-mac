import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {produceSourceCandidate} from '../src/production.js';
const image=JSON.parse(readFileSync(new URL('fixtures/legacy-v1.json',import.meta.url))).panels[0].image;
function fixture(){const panels=[0,1].map(i=>({id:`new${i}`,snapshotId:'new',sceneId:'S',unitIds:[],sourceRefs:[],characterIds:[],image:null,artwork_revision:null,prompt:'art',attempts:0,instructions:[]}));const c={prepared:{identity:{workId:'w',baseContentToken:'base'}},patch:{panels,layout:{pages:[]},sourceApplication:{version:1,units:[]}},redrawPanelIds:panels.map(p=>p.id)};return {workId:'w',contentToken:'base',active:'new',panels:[{id:'old',image}],layout:{pages:[]},sourceApplication:{version:1,units:[]},history:[],characters:[],artworks:[],jobs:[{id:'op',kind:'sourcePatch',status:'candidate',source_candidate:c}]};}
test('candidate image jobs reuse production, preserve adopted manga, and resume only missing art',async()=>{
 let p=fixture(),count=0,stopped=false;const before=structuredClone(p.panels),commits=[];
 const options={current:()=>p,commit:async next=>{p=typeof next==='function'?next(p):next;commits.push(structuredClone(p));return p;},opId:'op',generate:async panel=>{count++;stopped=true;return {...panel,image};},cancelled:()=>stopped};
 await produceSourceCandidate(options);assert.equal(count,1);assert.deepEqual(p.panels,before);assert.equal(p.jobs[0].source_candidate.redrawPanelIds.length,1);assert.equal(p.history.length,0);
 stopped=false;await produceSourceCandidate({...options,cancelled:()=>false});assert.equal(count,2);assert.equal(p.jobs[0].source_candidate.redrawPanelIds.length,0);assert.equal(p.artworks.length,2);
 await produceSourceCandidate({...options,cancelled:()=>false});assert.equal(count,2);assert.ok(commits.every(c=>JSON.stringify(c.panels)===JSON.stringify(before)));assert.ok(p.jobs.slice(1).every(j=>j.sourcePatchOp==='op'&&j.status==='complete'));
});
test('failed generation remains unknown and is not silently regenerated; changed work cannot start',async()=>{
 let p=fixture(),calls=0;const options={current:()=>p,commit:async next=>(p=typeof next==='function'?next(p):next),opId:'op',generate:async()=>{calls++;throw Error('lost response');},recover:async()=>{throw Error('no receipt yet');}};
 await assert.rejects(produceSourceCandidate(options),/lost response/);assert.equal(p.jobs[1].status,'unknown');await assert.rejects(produceSourceCandidate(options),/no receipt/);assert.equal(calls,1);
 p.workId='other';await assert.rejects(produceSourceCandidate(options),/古い/);assert.equal(calls,1);
});
test('GPU waiter revalidates after an independent adoption, then sends once and preserves that adoption',async()=>{
 const {withResource}=await import('../src/execution.js');let release;const blocker=withResource('local-inference',1,()=>new Promise(resolve=>release=resolve));await new Promise(r=>setImmediate(r));
 let p=fixture(),sends=0,refreshes=[];const task=produceSourceCandidate({current:()=>p,commit:async update=>(p=typeof update==='function'?update(p):update),opId:'op',generate:async panel=>{sends++;assert.equal(p.jobs[0].source_candidate.prepared.identity.baseContentToken,'adopted-A');return {...panel,image};},refresh:async()=>{refreshes.push(p.contentToken);p.jobs[0].source_candidate.prepared.identity.baseContentToken=p.contentToken;}});
 await new Promise(r=>setImmediate(r));assert.equal(sends,0);p={...p,contentToken:'adopted-A',panels:[{...p.panels[0],id:'adopted-A'}]};release();await blocker;await task;assert.equal(sends,2);assert.ok(refreshes.includes('adopted-A'));assert.equal(p.panels[0].id,'adopted-A');assert.equal(p.jobs[0].source_candidate.redrawPanelIds.length,0);
});
