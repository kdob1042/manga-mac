import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../src/core.js';
import { ensureLayout } from '../src/layout.js';
import { defaultLettering } from '../src/lettering.js';
import { prepareDraftLayout,finishDraftLettering,reviewDraft } from '../src/draft.js';
function fixture(){return ensureLayout({...emptyProject(),active:'s',snapshots:[{id:'s',scenes:[{id:'a',text:'一。\n\n二。'}]}],panels:[0,1].map(i=>({id:`p${i}`,sceneId:'a',snapshotId:'s',unitIds:[`a:u${i}`],characterIds:[],image:`art${i}`}))});}
test('lettering failure resumes only missing lettering, retaining rendered images and source',async()=>{
 let p=fixture(),calls=0,fail=true;
 const args={current:()=>p,commit:async next=>{p=JSON.parse(JSON.stringify(next));},cancelled:()=>false,notify:()=>{},ask:async prompt=>{calls++;const input=JSON.parse(prompt);if(calls===2&&fail)throw Error('offline');return JSON.stringify({reason:'文字量',layout:input.current});}};
 await assert.rejects(()=>finishDraftLettering(args));assert.ok(p.panels[0].lettering);assert.equal(p.panels[1].lettering,undefined);assert.deepEqual(p.panels.map(p=>p.image),['art0','art1']);
 fail=false;await finishDraftLettering(args);assert.equal(calls,3);assert.ok(p.panels.every(p=>p.lettering));
 const outputs=await reviewDraft(p,async panels=>panels.map(p=>p.id).join(','));assert.deepEqual(outputs,['p0,p1']);
});
test('cancelled and changed-baseline lettering are not adopted; existing manual lettering is not replaced',async()=>{
 let p=fixture(),cancel=false;
 await assert.rejects(()=>finishDraftLettering({current:()=>p,commit:async n=>{p=n;},cancelled:()=>cancel,notify:()=>{},ask:async prompt=>{cancel=true;return JSON.stringify({reason:'x',layout:JSON.parse(prompt).current});}}));
 assert.equal(p.panels[0].lettering,undefined);
 p.panels=p.panels.map(panel=>({...panel,lettering:defaultLettering(panel)}));
 await finishDraftLettering({current:()=>p,commit:async()=>assert.fail(),cancelled:()=>false,notify:()=>{},ask:async()=>assert.fail()});
});
test('draft review checks source completeness and render overflow rather than declaring job success sufficient',async()=>{
 const p=fixture();p.panels=p.panels.map(panel=>({...panel,lettering:defaultLettering(panel)}));
 await assert.rejects(()=>reviewDraft(p,async()=>{throw Error('文字あふれ');}),/文字あふれ/);
 p.panels[1].unitIds=['a:u0'];await assert.rejects(()=>reviewDraft(p,async()=>assert.fail()),/原文/);
});
test('accepted art and manual layouts are not replaced by initial layout',async()=>{
 const p=fixture();await prepareDraftLayout({current:()=>p,commit:async()=>assert.fail(),cancelled:()=>false,ask:async()=>assert.fail()});
});
