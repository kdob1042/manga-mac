import {test} from 'node:test';import assert from 'node:assert/strict';
import {sourceView,sourceSelection,toggleSourceGroup} from '../src/source-view.js';
import {tokenizeSnapshot} from '../src/source-refs.js';
function project(oldScenes,newScenes){const snapshots=[{id:'old',scenes:oldScenes},{id:'new',scenes:newScenes}];return {workId:'w',contentToken:'t',active:'new',snapshots,sourceApplication:{version:1,units:tokenizeSnapshot(snapshots[0]).map((u,i)=>({id:`u${i}`,source:u.source,requiredText:[u.source]}))}};}
test('scene removal and trailing deletion keep annotations at common diff anchors; snapshot text is untouched',()=>{
 const p=project([{id:'gone',text:'old scene'},{id:'keep',text:'A\n\nB'}],[{id:'keep',text:'A'}]),before=structuredClone(p),v=sourceView(p);
 assert.deepEqual(v.rows.map(r=>r.type),['change','applied','change']);assert.equal(v.resolve(v.rows[0].oldRefs[0]),'old scene');assert.equal(v.resolve(v.rows[2].oldRefs[0]),'B');assert.deepEqual(p,before);
 const selection=sourceSelection(p,v.changes,v.changes.blocks.map(b=>b.id));assert.equal(selection.selectedBlockIds.length,2);
 p.jobs=[{status:'running'}];assert.deepEqual(sourceSelection(p,v.changes,selection.selectedBlockIds),selection);
 p.active='old';assert.throws(()=>sourceSelection(p,v.changes,selection.selectedBlockIds),/選択し直して/);
});
test('ambiguous repeated paragraphs remain a single old/new group and unknown selections fail closed',()=>{
 const p=project([{id:'S',text:'うん\n\nうん'}],[{id:'S',text:'うん'}]),v=sourceView(p),b=v.changes.blocks[0];assert.equal(v.changes.blocks.length,1);assert.equal(b.diagnostic,'ambiguous_alignment');
 assert.deepEqual(toggleSourceGroup(v.changes,[],b.id),[b.id]);assert.deepEqual(toggleSourceGroup(v.changes,[b.id],b.id),[]);assert.throws(()=>sourceSelection(p,v.changes,['other']));assert.throws(()=>sourceSelection({...p,workId:'different'},v.changes,[b.id]));
});
