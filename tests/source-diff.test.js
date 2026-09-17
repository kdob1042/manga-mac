import {test} from 'node:test';import assert from 'node:assert/strict';
import {buildChangeSet,buildExpectedApplication} from '../src/source-diff.js';import {tokenizeSnapshot,sourceResolver} from '../src/source-refs.js';
function fixture(b,t){const snapshots=[{id:'old',scenes:[{id:'s',text:b.join('\n\n')}]},{id:'new',scenes:[{id:'s',text:t.join('\n\n')}]}];return {workId:'w',contentToken:'token',active:'new',snapshots,panels:[],sourceApplication:{version:1,units:tokenizeSnapshot(snapshots[0]).map((u,i)=>({id:`u${i}`,source:u.source,requiredText:[u.source]}))}};}
const text=(p,units)=>units.map(u=>sourceResolver(p.snapshots)(u.source));
test('all/none selections across all binary paragraph sequences preserve exact target/source',()=>{
 const arrays=[[]];for(let n=1;n<=4;n++)for(let bits=0;bits<2**n;bits++)arrays.push(Array.from({length:n},(_,i)=>(bits>>i)&1?'B':'A'));
 for(const old of arrays)for(const fresh of arrays){const p=fixture(old,fresh),c=buildChangeSet(p);
 assert.deepEqual(text(p,buildExpectedApplication(p,c,[]).afterUnits),old);
 assert.deepEqual(text(p,buildExpectedApplication(p,c,c.blocks.map(b=>b.id)).afterUnits),fresh);
 for(let mask=0;mask<2**c.blocks.length;mask++){
  const selected=c.blocks.filter((_,i)=>mask&(1<<i)).map(b=>b.id),after=buildExpectedApplication(p,c,selected);
  const partial={...p,contentToken:`partial:${mask}`,sourceApplication:{version:1,units:after.afterUnits}},remaining=buildChangeSet(partial);
  assert.deepEqual(text(partial,buildExpectedApplication(partial,remaining,remaining.blocks.map(b=>b.id)).afterUnits),fresh);
 }
 }
});
test('partial import followed by revision retains unapplied additions; repeated dialogue is ambiguous',()=>{
 const p=fixture(['A','B','C'],['A','X','B','C','Y']),c=buildChangeSet(p),expected=buildExpectedApplication(p,c,[c.blocks[0].id]);assert.deepEqual(text(p,expected.afterUnits),['A','X','B','C']);
 p.sourceApplication.units=expected.afterUnits;p.contentToken='next';p.snapshots.push({id:'newest',scenes:[{id:'s',text:'A\n\nXX\n\nB\n\nC\n\nY'}]});p.active='newest';const next=buildChangeSet(p);assert.equal(next.blocks.length,2);
 const repeated=buildChangeSet(fixture(['うん','うん'],['うん']));assert.equal(repeated.blocks.length,1);assert.equal(repeated.blocks[0].oldUnitIds.length,2);assert.equal(repeated.blocks[0].diagnostic,'ambiguous_alignment');
});
test('unique moves reuse old unit identities and references; stale selections are rejected',()=>{
 const p=fixture(['A','B','C'],['B','C','A']),c=buildChangeSet(p);assert.equal(c.blocks.length,1);assert.equal(c.blocks[0].kind,'move');const result=buildExpectedApplication(p,c,[c.blocks[0].id]);assert.deepEqual(result.afterUnits.map(u=>u.id),['u1','u2','u0']);assert.equal(result.afterUnits[2].source.snapshotId,'old');p.contentToken='changed';assert.throws(()=>buildExpectedApplication(p,c,[c.blocks[0].id]),/選び直/);
});
