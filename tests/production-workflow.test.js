import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyProject} from '../src/core.js';
import {initialLayout} from '../src/layout.js';
import {defaultLettering} from '../src/lettering.js';
import {tokenizeSnapshot} from '../src/source-refs.js';
import {completeSection,sectionStatus,reopenSection,undoCompletion,completionProblems} from '../src/section-completion.js';
import {producePanels} from '../src/production.js';
import {buildChangeSet,buildExpectedApplication} from '../src/source-diff.js';
import {proposeSourceReplan} from '../src/source-replan.js';
import {editName,namePanels,validateName} from '../src/name-edit.js';
import {refreshSourceCandidate} from '../src/source-patch.js';
const image='data:image/png;base64,YQ==';
function fixture(){
 const snapshot={id:'s',repo:'owner/book',scenes:[{id:'a',text:'first'},{id:'b',text:'second'}],settings:[]};
 const units=tokenizeSnapshot(snapshot).map((u,i)=>({id:`u${i}`,source:u.source,requiredText:[u.source]}));
 const panels=units.map((u,i)=>{const p={id:`p${i}`,sceneId:u.source.sceneId,snapshotId:'s',unitIds:[],sourceRefs:[u.source],characterIds:[],prompt:'art',image,instructions:[],attempts:0};return {...p,lettering:defaultLettering(p)};});
 return {...emptyProject(),version:5,workId:'book',active:'s',contentToken:'base',snapshots:[snapshot],panels,layout:initialLayout(panels),sourceApplication:{version:1,units}};
}
test('section approval is explicit, locally invalidated and survives unrelated snapshot/metadata/candidate changes',()=>{
 let p=fixture();p=completeSection(completeSection(p,'a'),'b');assert.equal(sectionStatus(p,'a'),'完了');
 const newer=structuredClone(p.snapshots[0]);newer.id='new';newer.scenes[0].text='changed';p={...p,active:'new',snapshots:[...p.snapshots,newer],contentToken:'changed'};
 assert.equal(sectionStatus(p,'a'),'要確認');assert.equal(sectionStatus(p,'b'),'完了');
 p.jobs.push({id:'unused',panelId:'p1',status:'candidate'});assert.equal(sectionStatus(p,'b'),'完了');
 p.layout.imageCrops={p0:{zoom:2,x:0,y:0}};assert.equal(sectionStatus(p,'b'),'完了');
 const reopened=reopenSection(p,'b');assert.equal(sectionStatus(reopened,'b'),'制作中');assert.equal(sectionStatus(undoCompletion(reopened),'b'),'完了');
 assert.throws(()=>completeSection(p,'a'),/未割当|未反映/);
});
test('completion rejects missing artwork and unresolved jobs; shared characters invalidate only dependent sections',()=>{
 let p=fixture();p.panels[0].image=null;assert.throws(()=>completeSection(p,'a'),/未作画/);p.panels[0].image=image;
 p.jobs.push({id:'x',panelId:'p0',status:'unknown'});assert.throws(()=>completeSection(p,'a'),/未確定/);p.jobs=[];
 p.characters=[{id:'c',hash:'before'}];p.panels[0].characterIds=['c'];p=completeSection(completeSection(p,'a'),'b');p.characters[0].hash='after';assert.equal(sectionStatus(p,'a'),'要確認');assert.equal(sectionStatus(p,'b'),'完了');
});
test('batch uses fixed panel IDs and no planning; stop/restart generates only remaining panels',async()=>{
 let p=fixture();p.panels.forEach(x=>x.image=null);const original=structuredClone(p),sent=[];let stop=false;
 const args={current:()=>p,commit:async n=>(p=typeof n==='function'?n(p):n),panelIds:['p0','p1'],imageModelId:'flux-2-klein-4b-local',cancelled:()=>stop,generate:async panel=>{sent.push(panel.id);stop=true;return {...panel,image};}};
 await producePanels(args);assert.deepEqual(sent,['p0']);assert.equal(p.panels[0].image,null);assert.equal(p.jobs[0].status,'candidate');
 // A completed running request with no cancellation is auto-adopted only for previously empty art.
 p=structuredClone(original);stop=false;args.generate=async panel=>{sent.push(panel.id);return {...panel,image};};await producePanels(args);assert.ok(p.panels.every(x=>x.image===image));assert.deepEqual(p.layout,original.layout);assert.deepEqual(p.panels.map(x=>x.sourceRefs),original.panels.map(x=>x.sourceRefs));
 await producePanels(args);assert.equal(sent.length,3);
});
test('unknown request prevents batch repost and leaves layout untouched',async()=>{
 let p=fixture();p.panels[0].image=null;let sent=0;const before=structuredClone(p.layout);
 const args={current:()=>p,commit:async n=>(p=typeof n==='function'?n(p):n),panelIds:['p0'],imageModelId:'flux-2-klein-4b-local',generate:async()=>{sent++;throw Error('lost response');}};
 await assert.rejects(producePanels(args),/lost response/);await assert.rejects(producePanels(args),/未確定/);assert.equal(sent,1);assert.deepEqual(p.layout,before);
});
test('manual name split/merge preserves all source and confirmed geometry survives refresh',async()=>{
 let p=fixture();p.snapshots[0].scenes[0].text='最初の文。次の文。最後の文。';p.panels=[];p.layout=initialLayout([]);p.sourceApplication.units=[];
 const changes=buildChangeSet(p),expected=buildExpectedApplication(p,changes,[changes.blocks[0].id]),prepared={expected,identity:{opId:'op',workId:p.workId,baseContentToken:p.contentToken,targetSnapshotId:p.active},plan:{scope:{pageIds:[],panelIds:[]}}};
 let c=await proposeSourceReplan(p,prepared,async prompt=>JSON.stringify({reason:'name',panels:JSON.parse(prompt).mutableUnits.map(a=>({unitIds:[a.id],prompt:'art',characterIds:[],reusePanelId:null}))}));
 validateName(p,c);assert.equal(namePanels(c).length,3);
 const refs=namePanels(c).flatMap(p=>p.sourceRefs);
 c=editName(p,c,[{refs}]);assert.equal(namePanels(c).length,1);
 c=editName(p,c,[{refs:refs.slice(0,1)},{refs:refs.slice(1)}]);assert.equal(namePanels(c).length,2);
 assert.deepEqual(namePanels(c).flatMap(p=>p.sourceRefs),refs);
 assert.throws(()=>editName(p,c,[]),/欠落/);
 c.patch.layout.pages[0].slots[0].points[0][0]+=.01;c.nameConfirmed=true;
 const next=await refreshSourceCandidate(p,c,async()=>prepared.plan);assert.deepEqual(next.patch.layout,c.patch.layout);assert.equal(next.nameConfirmed,true);
 assert.throws(()=>editName(p,c,[]),/確定/);
});

test('legacy completion renders a migration requirement instead of throwing',()=>{
 const p=fixture();delete p.contentToken;delete p.sourceApplication;
 assert.match(completionProblems(p,'a').join(' '),/移行/);
});
test('unchanged applied paragraph can be explicitly replanned without making the default diff dirty',()=>{
 const p=fixture();assert.equal(buildChangeSet(p).blocks.length,0);
 const changes=buildChangeSet(p,p.active,{replanApplied:true});assert.equal(changes.blocks.length,2);
 const expected=buildExpectedApplication(p,changes,[changes.blocks[0].id]);
 assert.deepEqual(expected.afterUnits.map(u=>u.source),p.sourceApplication.units.map(u=>u.source));
 assert.equal(expected.afterUnits[1].id,p.sourceApplication.units[1].id);
 assert.notEqual(expected.afterUnits[0].id,p.sourceApplication.units[0].id);
});

test('source candidate generation blocks approval only in its own section',()=>{
 const p=fixture();p.jobs=[{id:'source-op',kind:'sourcePatch',status:'candidate',run:{stage:'drawing'},source_patch:{expected:{sourceEdits:[{newRefs:[p.sourceApplication.units[0].source],oldUnitIds:[]}]}}}];
 assert.match(completionProblems(p,'a').join(' '),/未確定/);assert.deepEqual(completionProblems(p,'b'),[]);
 p.jobs[0].run.stage='candidate';assert.deepEqual(completionProblems(p,'a'),[]);
});
