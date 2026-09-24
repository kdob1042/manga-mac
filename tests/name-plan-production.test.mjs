import test from 'node:test';
import assert from 'node:assert/strict';
import { fileFixture, leaf, split } from './name-plan-fixture.mjs';
import { createNameCandidate, adoptNameCandidate, validateV2State, refreshNameBindings } from '../src/name-v2.js';
import { produceNameDraft, finalizeNameApplication, nameGenerationSize } from '../src/name-v2-production.js';
const descriptor={input:{min_width:64,min_height:64,max_width:1536,max_height:1536,step:64}};
const tiny='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/GmsAAAAASUVORK5CYII=';
async function draft() { const f=await fileFixture(2,'# Scene\n\n彼は手を振る。\n\n「また明日」');return adoptNameCandidate(f.project,await createNameCandidate(f.project,f.file)); }
test('generation dimensions preserve portrait/landscape/splash aspect without a square default',()=>{
 for(const points of [[[.04,.04],[.96,.04],[.96,.96],[.04,.96]],[[.04,.04],[.96,.04],[.96,.30],[.04,.30]],[[.5,.04],[.96,.04],[.96,.96],[.5,.96]]]){
  const size=nameGenerationSize(points,descriptor);assert.ok(size.ratioError<=.03);assert.notEqual(size.resolution[0],size.resolution[1]);
 }
 assert.throws(()=>nameGenerationSize([[0,0],[1,0],[1,.01],[0,.01]],descriptor),/比率/);
});
test('production adapter persists art/text then proves before finalizing source',async()=>{
 let p=await draft(),phase=[],renders=0;const original=structuredClone(p.layout);
 const args={current:()=>p,commit:async next=>{p=structuredClone(next);phase.push(p.namePlan.productionState??'saved');return p;},cancelled:()=>false,model:{visualEditing:false},productionMode:'direct',setBusy:()=>{},setNotice:()=>{},showProof:()=>phase.push('shown'),imageModelId:'fixture',resolveModel:()=>descriptor,
  generateBatch:async({current,commit,panelIds})=>{await commit({...current(),panels:current().panels.map(panel=>panelIds.includes(panel.id)?{...panel,image:tiny,artwork_revision:'art:'+panel.id}:panel)});phase.push('art');},
  finishText:async({current,commit,panelIds})=>{await commit({...current(),panels:current().panels.map(panel=>panelIds.includes(panel.id)?{...panel,letteringStatus:'ready',letteringArtworkRevision:panel.artwork_revision}:panel)});phase.push('text');},
  pagePNG:async()=>{assert.equal(p.sourceApplication.units.length,0);renders++;phase.push('proof');return 'page';}};
 const out=await produceNameDraft(args);assert.equal(out.state,'proof-ready');assert.equal(renders,1);assert.deepEqual(p.layout,original);assert.equal(p.sourceApplication.units.length,2);assert.deepEqual(p.sourceApplication.units[0].requiredText,[]);assert.equal(p.sourceApplication.units[1].requiredText.length,1);
 assert.ok(phase.indexOf('proof')<phase.indexOf('proof-ready'));assert.equal(phase.at(-1),'shown');
});
test('proof failure cannot mark a source complete',async()=>{
 let p=await draft();const layout=structuredClone(p.layout);
 await assert.rejects(()=>produceNameDraft({current:()=>p,commit:async next=>{p=next;return p;},cancelled:()=>false,model:{},productionMode:'direct',setBusy:()=>{},setNotice:()=>{},showProof:()=>assert.fail(),resolveModel:()=>descriptor,
 generateBatch:async({current,commit})=>commit({...current(),panels:current().panels.map(panel=>({...panel,image:tiny,artwork_revision:'art'}))}),
 finishText:async({current,commit})=>commit({...current(),panels:current().panels.map(panel=>({...panel,letteringStatus:'ready',letteringArtworkRevision:'art'}))}),pagePNG:async()=>{throw Error('text overflow');}}),/overflow/);
 assert.equal(p.sourceApplication.units.length,0);assert.deepEqual(p.layout,layout);assert.ok(p.panels.every(panel=>panel.image));
});
test('unfinished art and missing required text are rejected by finalization',async()=>{
 const p=await draft();assert.throws(()=>finalizeNameApplication(p),/未完了/);
 p.panels=p.panels.map(panel=>({...panel,image:tiny,letteringStatus:'ready'}));p.panels[1].lettering.boxes=[];
 assert.throws(()=>finalizeNameApplication(p),/文字/);
});
test('reference updates keep names usable without losing old art or manual geometry',async()=>{
 const p=await draft(),snapshot=p.snapshots.find(snapshot=>snapshot.id===p.active);
 snapshot.characters=[{id:'new',name:'new'}];
 const next=await refreshNameBindings(p);assert.equal(next.namePlan.status,'adopted');assert.deepEqual(next.layout,p.layout);
});
