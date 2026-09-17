import {test} from 'node:test';import assert from 'node:assert/strict';
import {buildChangeSet,buildExpectedApplication} from '../src/source-diff.js';
import {proposeSourceReplan,sourceReplanInput,validateSourceCandidate} from '../src/source-replan.js';
import {tokenizeSnapshot} from '../src/source-refs.js';import {initialLayout} from '../src/layout.js';import {defaultLettering} from '../src/lettering.js';
function fixture(old='A\n\nB\n\nC',fresh='X\n\nB\n\nC\n\nY'){
 const snapshots=[{id:'old',scenes:[{id:'S',text:old}]},{id:'new',scenes:[{id:'S',text:fresh}]}],units=tokenizeSnapshot(snapshots[0]).map((u,i)=>({id:`u${i}`,source:u.source,requiredText:[u.source]}));
 const panels=units.map((u,i)=>{const p={id:`p${i}`,sourceRefs:[u.source],image:'image',prompt:'art',characterIds:[]};p.lettering=defaultLettering(p);return p;});
 return {version:5,workId:'w',contentToken:'base',active:'new',snapshots,characters:[],panels,layout:initialLayout(panels),sourceApplication:{version:1,units}};
}
function prepared(p,select=()=>true){const changes=buildChangeSet(p),expected=buildExpectedApplication(p,changes,changes.blocks.filter(select).map(b=>b.id));return {expected,identity:{opId:'op',workId:p.workId,baseContentToken:p.contentToken,targetSnapshotId:p.active},plan:{scope:{pageIds:p.layout.pages.map(p=>p.id)}}};}
const answer=(input,reusePanelId='p0')=>JSON.stringify({reason:'台詞だけ変更',panels:[{unitIds:input.mutableUnits.map(u=>u.id),prompt:'art',characterIds:[],reusePanelId}]});
test('selected A update keeps shared old B, excludes unselected additions, and reuses art',async()=>{
 const p=fixture('A\n\nB\n\nC','X\n\nB2\n\nC\n\nY');
 // A and B must be separate selectable blocks, so put an unchanged anchor between them.
 p.snapshots[1].scenes[0].text='X\n\nB\n\nC\n\nY';
 p.panels[0].sourceRefs.push(p.panels[1].sourceRefs[0]);p.panels[0].lettering=defaultLettering(p.panels[0]);p.panels.splice(1,1);p.layout=initialLayout(p.panels);
 const prep=prepared(p,b=>b.kind==='replace'),input=sourceReplanInput(p,prep.expected);assert.deepEqual(input.atoms.map(a=>a.text),['X','B']);
 let calls=0;const c=await proposeSourceReplan(p,prep,async prompt=>{calls++;const data=JSON.parse(prompt);assert.ok(!JSON.stringify(data).includes('Y'));return answer(data);});
 assert.equal(calls,1);assert.equal(c.redrawPanelIds.length,0);assert.equal(c.patch.panels[0].image,p.panels[0].image);assert.notEqual(c.patch.panels[0].id,p.panels[0].id);assert.deepEqual(c.patch.panels[0].sourceRefs.map(r=>r.snapshotId),['new','old']);validateSourceCandidate(p,c);
 const remaining=buildChangeSet({...p,...c.patch,contentToken:'next'});assert.equal(remaining.blocks.length,1);assert.equal(remaining.blocks[0].kind,'insert');assert.deepEqual(c.patch.panels.at(-1),p.panels.at(-1));
});
test('pure deletion removes empty content, move reuses panel IDs, missing art never adopts',async()=>{
 let p=fixture('A\n\nB','A'),c=await proposeSourceReplan(p,prepared(p),()=>{throw Error('No model for pure deletion');});assert.equal(c.patch.panels.length,1);validateSourceCandidate(p,c);
 p=fixture('A\n\nB\n\nC\n\nD','B\n\nC\n\nD\n\nA');c=await proposeSourceReplan(p,prepared(p),()=>{throw Error('No model for move');});assert.deepEqual(c.patch.panels.map(p=>p.id),['p1','p2','p3','p0']);assert.deepEqual(c.patch.panels.at(-1),p.panels[0]);
 p=fixture('', 'new content');c=await proposeSourceReplan(p,prepared(p),async prompt=>answer(JSON.parse(prompt),null));assert.equal(c.redrawPanelIds.length,1);assert.equal(p.panels.length,0);assert.throws(()=>validateSourceCandidate(p,c),/作画/);
});
test('model cannot omit atoms, reuse outside art or erase a manual shared panel',async()=>{
 const p=fixture(),prep=prepared(p,b=>b.kind==='replace');
 await assert.rejects(proposeSourceReplan(p,prep,async()=>JSON.stringify({reason:'omit',panels:[]})),/欠落/);
 await assert.rejects(proposeSourceReplan(p,prep,async prompt=>answer(JSON.parse(prompt),'p1')),/対象外/);
 p.panels[0].manual=true;await assert.rejects(proposeSourceReplan(p,prep,async prompt=>answer(JSON.parse(prompt))),/手動/);
});
test('one paragraph splits across panels with exact required text coverage and app-owned offsets',async()=>{
 const p=fixture('旧文。','新しい文。続く文。'),prep=prepared(p);
 const c=await proposeSourceReplan(p,prep,async prompt=>{const input=JSON.parse(prompt);assert.equal(input.mutableUnits.length,2);return JSON.stringify({reason:'二つのコマに分割',panels:input.mutableUnits.map(u=>({unitIds:[u.id],prompt:'art',characterIds:[],reusePanelId:'p0'}))});});
 assert.equal(c.patch.sourceApplication.units.length,1);assert.equal(c.patch.panels.length,2);validateSourceCandidate(p,c);
 assert.equal(c.patch.panels[0].sourceRefs[0].endCp,c.patch.panels[1].sourceRefs[0].startCp);
});
