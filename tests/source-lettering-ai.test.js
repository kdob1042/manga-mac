import {test} from 'node:test';import assert from 'node:assert/strict';
import {proposeLettering} from '../src/lettering-ai.js';
const snapshots=[{id:'v1',scenes:[{id:'S',text:'旧B'}]},{id:'v2',scenes:[{id:'S',text:'新A😊'}]}];
const refs=[{snapshotId:'v2',sceneId:'S',startCp:0,endCp:3},{snapshotId:'v1',sceneId:'S',startCp:0,endCp:2}];
function fixture(){return {id:'p',sourceRefs:refs,lettering:{mode:'balloons',boxes:refs.map((r,i)=>({id:`independent-${i}`,sourceRefs:[r],x:.1,y:.1+i*.4,width:.4,height:.3}))}};}
const response=p=>({reason:'move only',layout:{mode:'balloons',boxes:p.lettering.boxes.map(({sourceRefs,...b})=>({...b,x:.2}))}});
test('mixed source versions and independent box IDs survive AI geometry changes without passing offsets',async()=>{
 const p=fixture(),original=structuredClone(p);const layout=await proposeLettering({snapshots},p,'少し右へ',async(prompt,schema)=>{const data=JSON.parse(prompt);assert.deepEqual(data.boxes.map(b=>b.text),['新A😊','旧B']);assert.ok(data.boxes.every(b=>!b.sourceRefs));assert.equal(schema.properties.layout.properties.boxes.items.properties.unit_id,undefined);return JSON.stringify(response(p));});
 assert.deepEqual(layout.boxes.map(b=>b.sourceRefs),refs.map(r=>[r]));assert.deepEqual(p,original);assert.equal(layout.boxes[0].x,.2);
});
test('missing, reordered, forged-reference and locked-box responses are rejected',async()=>{
 for(const mutate of [r=>r.layout.boxes.pop(),r=>r.layout.boxes.reverse(),r=>r.layout.boxes[0].sourceRefs=[]]){const p=fixture(),r=response(p);mutate(r);await assert.rejects(proposeLettering({snapshots},p,'',async()=>JSON.stringify(r)));}
 const p=fixture();p.lettering.boxes[0].locked=true;await assert.rejects(proposeLettering({snapshots},p,'',async()=>JSON.stringify(response(p))),/固定/);
 const r=response(p);r.layout.boxes[0].x=.1;const out=await proposeLettering({snapshots},p,'',async()=>JSON.stringify(r));assert.deepEqual(out.boxes[0],p.lettering.boxes[0]);
});
