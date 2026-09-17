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

test('selected scenes keep source order and reject out-of-scope panels before any generation',async()=>{
 const {startDraft,draftScenes}=await import('../src/draft.js');
 const p=fixture();p.snapshots[0].scenes.push({id:'b',text:'別の場面'});
 const scoped=startDraft(p,['a']);assert.deepEqual(draftScenes(scoped).map(s=>s.id),['a']);
 assert.throws(()=>startDraft(p,['b']),/別の初稿/);
 assert.throws(()=>startDraft(p,[]),/場面/);
 const next=startDraft(scoped,['b'],true);assert.equal(next.panels.length,0);assert.deepEqual(next.draftScope.sceneIds,['b']);
 const lettered={...scoped,panels:scoped.panels.map(p=>({...p,lettering:defaultLettering(p)}))};
 assert.equal((await reviewDraft(lettered,async()=> 'page')).length,1);
});
test('separate draft checkpoints survive restart and restore exact art, layout, source and motion without reverting jobs',async()=>{
 const {startDraft,restoreDraft,preserveDraft}=await import('../src/draft.js');
 const {undoEdit}=await import('../src/edit-commands.js');
 let p=fixture();p.panelMotions=[{id:'motion',panelId:'p0'}];p.layout.imageCrops={p0:{zoom:2,x:.4,y:.3}};
 p=preserveDraft(p);const old=p.history.at(-1),oldState=structuredClone(p);
 p.snapshots.push({id:'revised',scenes:[{id:'a',text:'改訂'}]});p.active='revised';
 let next=startDraft(p,['a'],true);assert.deepEqual(next.panelMotions,[]);assert.throws(()=>undoEdit(next),/原稿の切替/);
 next.jobs.push({id:'new-job',status:'complete'});next=JSON.parse(JSON.stringify(next));
 const restored=restoreDraft(next,old.id);
 assert.deepEqual(restored.panels,oldState.panels);assert.deepEqual(restored.layout,oldState.layout);assert.deepEqual(restored.panelMotions,oldState.panelMotions);assert.equal(restored.active,'s');assert.equal(restored.jobs.at(-1).id,'new-job');
 assert.deepEqual(restored.snapshots,p.snapshots);assert.equal(restored.history.at(-1).panels.length,0);
});
test('unknown image requests block draft switching, invalid layouts block restore',async()=>{
 const {startDraft,restoreDraft}=await import('../src/draft.js');
 const p=fixture();p.jobs=[{id:'j',panelId:'p0',kind:'generate',status:'unknown'}];assert.throws(()=>startDraft(p,['a'],true),/未確定/);
 p.jobs=[];const next=startDraft(p,['a'],true);const h=next.history.at(-1);h.layout.pages[0].slots[0].points[0]=[2,2];assert.throws(()=>restoreDraft(next,h.id),/凸四角形/);
});
