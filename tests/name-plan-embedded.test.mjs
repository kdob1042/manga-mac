import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,leaf} from './name-plan-fixture.mjs';
import {emptyProject} from '../src/core.js';
import {stageEmbeddedName} from '../src/name-entry.js';
import {allNamePlans,selectNamePart} from '../src/name-parts.js';
import {createNameFile,createNameCandidate,adoptNameCandidate,validateV2State,refreshNameBindings,nameReadToken} from '../src/name-v2.js';
import {resolveRef} from '../contracts/name-plan/source.mjs';
import {sealSnapshots,upgradeSourceProject} from '../src/source-application.js';
import {generatePanel} from '../src/pipeline.js';
import {undoEdit} from '../src/edit-commands.js';

async function files(){
 const f=fixture(2,'# 当時の原文\r\n\r\n「前半😀」\r\n\r\n「後半」');
 f.snapshot.characters=[{id:'yumi',name:'由美'}];
 return Promise.all(f.atoms.flatMap((atom,i)=>atom.kind==='dialogue'?[i]:[]).map(async (i,part)=>{
  const plan=structuredClone(f.plan);plan.coverage=[plan.coverage[i]];plan.panels=[{...plan.panels[i],characterIds:['yumi']}];plan.beats[0].atomIds=[f.atoms[i].id];plan.pages=[{...plan.pages[0],tree:leaf(plan.panels[0].id)}];
  return createNameFile(f.project,plan,[f.atoms[i].id],{producer:'fixture',model:'',editedBy:[]},{number:part+1});
 }));
}
async function add(project,file,mode){const staged=await stageEmbeddedName(project,JSON.stringify(file));return adoptNameCandidate(staged,staged.jobs.at(-1).nameCandidate,mode);}

test('no manuscript: add numbered halves, preserve art and fixed IDs, reload and switch',async()=>{
 const [one,two]=await files();let p=await add(emptyProject(),one);
 assert.equal(p.snapshots.length,1);assert.ok(p.snapshots[0].embeddedName);assert.equal(p.characters.length,1);assert.equal(p.characters[0].source.character_id,'yumi');
 const first=p.panels[0];first.image='data:image/png;base64,fixture';first.artwork_revision='art:first';
 const page=structuredClone(p.layout.pages[0]);
 p=await add(p,two);assert.equal(allNamePlans(p).length,2);assert.equal(p.panels.length,2);assert.deepEqual(p.panels[0],first);assert.deepEqual(p.layout.pages[0],page);assert.equal(p.characters.length,1);
 assert.deepEqual(p.panels.map(panel=>resolveRef(p.snapshots,panel.requiredText[0])),['「前半😀」','「後半」']);
 p=JSON.parse(JSON.stringify(p));validateV2State(p);
 p=selectNamePart(p,p.otherNamePlans[0].id);assert.equal(p.namePlan.file.source.number,1);assert.equal(p.otherNamePlans[0].file.source.number,2);
 const upgraded=await upgradeSourceProject(p);validateV2State(upgraded);await sealSnapshots(upgraded.snapshots);
});
test('later manuscript edits and image reorder/replacement never invalidate embedded name or candidate',async()=>{
 const [one,two]=await files();let p=await add(emptyProject(),one);
 p.snapshots.push({id:'latest',repo:one.source.repo,workId:one.source.workId,scenes:[{id:'S01',text:'別の原稿'}],settings:['変更']});p.active='latest';
 const c=await createNameCandidate(p,two),token=await nameReadToken(p);
 p.characters[0].image='new image';p.characters[0].hash='changed';p.characters[0].description='new';p.characters.reverse();
 assert.equal(await nameReadToken(p),token);p=await adoptNameCandidate(p,c);p=await refreshNameBindings(p);assert.equal(p.namePlan.status,'adopted');assert.equal(resolveRef(p.snapshots,p.panels[0].requiredText[0]),'「前半😀」');
});
test('same number requires explicit replacement; other numbers, art and Undo checkpoint survive',async()=>{
 const [one,two]=await files();let p=await add(await add(emptyProject(),two),one);
 assert.equal(p.panels[0].requiredText[0].startCp< p.panels[1].requiredText[0].startCp,true);
 const second=structuredClone(p.panels[1]);const revised=structuredClone(one);revised.plan.panels[0].prompt='Different composition';
 const c=await createNameCandidate(p,revised);await assert.rejects(adoptNameCandidate(p,c),/採用済み/);
 p=await adoptNameCandidate(p,c,'replace-part');assert.deepEqual(p.panels[1],second);assert.equal(allNamePlans(p).length,2);
 p=undoEdit(p);assert.equal(p.namePlan.file.plan.panels[0].prompt,one.plan.panels[0].prompt);validateV2State(p);
});
test('missing yumi permits import and reports the exact ID only on drawing',async()=>{
 const [one]=await files(),p=await add(emptyProject(),one);validateV2State(p);
 await assert.rejects(generatePanel(p.panels[0],p.characters),/yumi.*参照画像がありません/);
});
test('embedded name rejects broken own text references and undeclared character IDs',async()=>{
 const [one]=await files();const bad=structuredClone(one);bad.source.scenes[0].text='別の本文';await assert.rejects(createNameCandidate(emptyProject(),bad));
 const badCharacter=structuredClone(one);badCharacter.source.characters=[];await assert.rejects(createNameCandidate(emptyProject(),badCharacter),/人物/);
});

test('editing a name preserves fixed panel IDs; content is not the identity',async()=>{
 const [one]=await files(),p=emptyProject(),before=await createNameCandidate(p,one);
 const changed=structuredClone(one);changed.plan.panels[0].prompt='Changed direction';
 const after=await createNameCandidate(p,changed);assert.notEqual(before.fileHash,after.fileHash);assert.equal(before.panels[0].id,after.panels[0].id);
});
