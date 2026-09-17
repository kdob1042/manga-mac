import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../src/core.js';
import { ensureLayout } from '../src/layout.js';
import { defaultLettering, setLettering } from '../src/lettering.js';
import { editBase, editContext, executeLocalEdits, validateEditPlan, undoEdit, planEdit } from '../src/edit-commands.js';
function fixture(){return ensureLayout({...emptyProject(),panels:Array.from({length:6},(_,i)=>({id:`p${i}`,unitIds:[`u${i}`],image:`art${i}`,characterIds:[]}))});}
function candidate(p,operations){return {base:editBase(p),context:editContext(p,0,null,null),plan:{reason:'対象だけ変更',operations}};}
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
