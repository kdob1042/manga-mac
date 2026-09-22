import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../src/core.js';
import { ensureLayout } from '../src/layout.js';
import { defaultLettering, setLettering } from '../src/lettering.js';
import { editBase, editContext, executeLocalEdits, validateEditPlan, undoEdit, planEdit } from '../src/edit-commands.js';
function fixture(){return ensureLayout({...emptyProject(),panels:Array.from({length:6},(_,i)=>({id:`p${i}`,unitIds:[`u${i}`],image:`art${i}`,characterIds:[]}))});}
function candidate(p,operations){return {base:editBase(p),context:editContext(p,0,null,null),plan:{reason:'対象だけ変更',operations}};}
test('moving text retains omitted writing direction and font, with explicit changes reversible',async()=>{
 const p=fixture(),panel=p.panels[0];panel.lettering=defaultLettering(panel);panel.lettering.mode='balloons';
 Object.assign(panel.lettering.boxes[0],{writingMode:'vertical-rl',fontFamily:'mincho'});
 const args=defaultLettering(panel);args.mode='balloons';args.boxes[0].x=.2;
 delete args.boxes[0].id; // Legacy AI responses may only return the immutable unit ID.
 const planned=await planEdit(p,editContext(p,0,panel.id,null),'1コマ目の文字を左へ',async()=>JSON.stringify({reason:'移動',operations:[{kind:'lettering',panelId:panel.id,args}]}));
 const changed=executeLocalEdits(p,planned);
 assert.equal(changed.panels[0].lettering.boxes[0].writingMode,'vertical-rl');
 assert.equal(changed.panels[0].lettering.boxes[0].fontFamily,'mincho');
 assert.deepEqual(undoEdit(changed).panels,p.panels);
 args.boxes[0].writingMode='horizontal-tb';
 const explicit=await planEdit(p,editContext(p,0,panel.id,null),'1コマ目の文字を横書きに',async()=>JSON.stringify({reason:'変更',operations:[{kind:'lettering',panelId:panel.id,args}]}));
 assert.equal(explicit.plan.operations[0].args.boxes[0].writingMode,'horizontal-tb');
});
test('compound lettering/crop share a single reversible persisted manga edit and preserve art/video/source',()=>{
 const p=fixture(),layout=defaultLettering(p.panels[2]);layout.mode='balloons';layout.boxes[0].x=.2;
 const c=candidate(p,[{kind:'lettering',panelId:'p2',args:layout},{kind:'crop',panelId:'p2',args:{x:.3,y:.5,zoom:1.2}}]);
 const next=executeLocalEdits(p,c);
 assert.equal(next.history.length,1);assert.deepEqual(next.panels.map(p=>p.image),p.panels.map(p=>p.image));assert.deepEqual(next.snapshots,p.snapshots);assert.deepEqual(next.videoShots,p.videoShots);
 const restored=JSON.parse(JSON.stringify(next)),undone=undoEdit(restored),redone=undoEdit(undone,true);
 assert.deepEqual(undone.panels,p.panels);assert.deepEqual(undone.layout,p.layout);assert.deepEqual(redone.panels,next.panels);assert.deepEqual(redone.layout,next.layout);
});
test('all operations preflight: bad second operation, stale response, hidden-page target and text changes never commit',()=>{
 const p=fixture(),original=JSON.stringify(p),l=defaultLettering(p.panels[0]);
 assert.throws(()=>executeLocalEdits(p,candidate(p,[{kind:'lettering',panelId:'p0',args:l},{kind:'crop',panelId:'p0',args:{x:3,y:.5,zoom:1}}])));
 assert.equal(JSON.stringify(p),original);
 const c=candidate(p,[{kind:'lettering',panelId:'p0',args:l}]);assert.throws(()=>executeLocalEdits({...p,revision:1},c));
 assert.throws(()=>executeLocalEdits(p,candidate(p,[{kind:'lettering',panelId:'p5',args:l}])));
 l.boxes[0].text='rewrite';assert.throws(()=>executeLocalEdits(p,candidate(p,[{kind:'lettering',panelId:'p0',args:l}])));
});
test('AI locks, uncertainty and generation composites fail closed; manual unlock and undo remain offline',async()=>{
 let p=fixture(),l=defaultLettering(p.panels[0]);l.boxes[0].locked=true;p=setLettering(p,'p0',l);
 const changed=structuredClone(l);changed.boxes[0].x=.2;
 assert.throws(()=>executeLocalEdits(p,candidate(p,[{kind:'lettering',panelId:'p0',args:changed}])));
 assert.throws(()=>validateEditPlan(p,{reason:'複合',operations:[{kind:'direction',panelId:'p0',args:{instruction:'寄って'}},{kind:'lettering',panelId:'p0',args:l}]},editContext(p,0,null,null)));
 let calls=0;await assert.rejects(()=>planEdit(p,editContext(p,0,null,null),'あれを直す',async()=>{calls++;},async()=>({choice:'unclear'})));assert.equal(calls,0);
 changed.boxes[0].locked=false;const next=setLettering(p,'p0',changed);assert.deepEqual(undoEdit(next).panels,p.panels);
});
test('page-local reading order resolves six-panel and second page IDs without selecting',()=>{
 const p=fixture(),ctx=editContext(p,1,'p0',null);assert.equal(ctx.selected,null);assert.deepEqual(ctx.panels.map(p=>[p.number,p.id]),[[1,'p4'],[2,'p5']]);
});
test('explicit ordinal is enforced against wrong model target and nonexistent page before execution',async()=>{
 const p=fixture(),ctx=editContext(p,0,null,null);
 await assert.rejects(()=>planEdit(p,ctx,'3コマ目の文字を左へ',async()=>JSON.stringify({reason:'wrong target',operations:[{kind:'lettering',panelId:'p0',args:defaultLettering(p.panels[0])}]})),/指定されたコマ/);
 await assert.rejects(()=>planEdit(p,ctx,'9コマ目を直す',async()=>assert.fail()),/ありません/);
 await assert.rejects(()=>planEdit(p,ctx,'2ページ目を直す',async()=>assert.fail()),/ページを表示/);
});
test('finishing/video operations validate capability and refuse mixed operations before starting any job',()=>{
 const p=fixture(),ctx=editContext(p,0,null,null);
 for(const [kind,args] of [['resolution',{}],['finishing',{}],['upscale',{factor:2}],['video_prepare',{instruction:'目を閉じる',ratio:'960:960'}]])assert.doesNotThrow(()=>validateEditPlan(p,{reason:'準備',operations:[{kind,panelId:'p0',args}]},ctx));
 assert.throws(()=>validateEditPlan(p,{reason:'不正',operations:[{kind:'upscale',panelId:'p0',args:{factor:8}}]},ctx));
 assert.throws(()=>validateEditPlan(p,{reason:'不正',operations:[{kind:'video_assign',panelId:'p0',args:{shotId:'invented'}}]},ctx));
 assert.throws(()=>executeLocalEdits(p,candidate(p,[{kind:'resolution',panelId:'p0',args:{}}])));
});

test('edit proposals persist without art copies in jobs; reopen after restart, reject changed art/source/references',async()=>{
 const {saveEditProposal,loadEditProposal,resolveEditProposal}=await import('../src/edit-commands.js');
 const p=fixture(),c=candidate(p,[{kind:'crop',panelId:'p0',args:{x:.4,y:.5,zoom:2}}]);
 const saved=await saveEditProposal(p,c),id=saved.jobs.at(-1).id;
 const reloaded=JSON.parse(JSON.stringify({...saved,revision:8}));
 const reopened=await loadEditProposal(reloaded,id);assert.equal(executeLocalEdits(reloaded,reopened).layout.imageCrops.p0.zoom,2);
 assert.equal(JSON.stringify(saved.jobs).includes('art0'),false);
 for(const changed of [{...reloaded,active:'new'},{...reloaded,characters:[{id:'new-ref'}]},{...reloaded,panels:reloaded.panels.map(p=>({...p,image:'changed'}))}])await assert.rejects(()=>loadEditProposal(changed,id),/原稿が変わった/);
 await assert.rejects(()=>loadEditProposal(resolveEditProposal(reloaded,id,'abandoned'),id),/候補がありません/);
 assert.deepEqual(saved.panels,p.panels);
});

test('generation composites commit lightweight edits together then stage results; failure retains progress without replay',async()=>{
 const {executeEditSequence,saveEditProposal,loadEditProposal}=await import('../src/edit-commands.js');
 let p=fixture(),calls=[];
 const operations=[{kind:'crop',panelId:'p0',args:{x:.4,y:.5,zoom:2}},{kind:'direction',panelId:'p0',args:{instruction:'寄る'}},{kind:'direction',panelId:'p1',args:{instruction:'引く'}}];
 p=await saveEditProposal(p,candidate(p,operations));const c=await loadEditProposal(p,p.jobs.at(-1).id);
 await assert.rejects(()=>executeEditSequence({current:()=>p,commit:async v=>{p=JSON.parse(JSON.stringify(v));},candidate:c,check:async()=>{},perform:async op=>{calls.push(op.panelId);assert.equal(p.layout.imageCrops.p0.zoom,2);if(op.panelId==='p1')throw Error('offline');}}),/2\/3/);
 assert.deepEqual(calls,['p0','p1']);assert.equal(p.history.length,1);assert.equal(p.jobs.at(-1).status,'partial');assert.equal(p.jobs.at(-1).completed,2);
 await assert.rejects(()=>loadEditProposal(p,c.jobId),/開始済み/);
 assert.deepEqual(p.panels.map(p=>p.image),fixture().panels.map(p=>p.image));
});
test('compound invalid tail is rejected before local changes or generated calls; cancellation never starts next operation',async()=>{
 const {executeEditSequence}=await import('../src/edit-commands.js');
 let p=fixture(),cancel=false,calls=0;
 const ops=[{kind:'crop',panelId:'p0',args:{x:.5,y:.5,zoom:2}},{kind:'direction',panelId:'p0',args:{instruction:'寄る'}},{kind:'direction',panelId:'p1',args:{instruction:''}}];
 await assert.rejects(()=>executeEditSequence({current:()=>p,commit:async()=>assert.fail(),candidate:candidate(p,ops),perform:async()=>assert.fail()}));
 ops[2].args.instruction='引く';
 await assert.rejects(()=>executeEditSequence({current:()=>p,commit:async v=>{p=v;},candidate:candidate(p,ops),cancelled:()=>cancel,perform:async()=>{calls++;cancel=true;}}),/停止/);
 assert.equal(calls,1);assert.equal(p.jobs.at(-1).status,'partial');
});

test('previous-target reference is derived from a completed saved operation on the displayed page',async()=>{
 const p=fixture();p.jobs=[{kind:'edit_proposal',status:'complete',context:{pageId:p.layout.pages[0].id},plan:{operations:[{kind:'crop',panelId:'p2'}]}}];
 const ctx=editContext(p,0,null,null);
 const result=await planEdit(p,ctx,'さっきのコマを少し右へ',async()=>JSON.stringify({reason:'直前の対象',operations:[{kind:'crop',panelId:'p2',args:{x:.4,y:.5,zoom:1}}]}));
 assert.deepEqual(result.context.explicitTargets,['p2']);
 await assert.rejects(()=>planEdit(p,editContext(p,1,null,null),'さっきのコマを右へ',async()=>assert.fail()),/一つに特定/);
});
