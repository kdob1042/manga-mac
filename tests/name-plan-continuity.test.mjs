import test from 'node:test';
import assert from 'node:assert/strict';
import {fileFixture} from './name-plan-fixture.mjs';
import {createNameCandidate, adoptNameCandidate} from '../src/name-v2.js';
import {parseNameFile, validatePlan} from '../contracts/name-plan/schema.mjs';
import {imageRequest} from '../src/image-input.js';
import {beginJob, finishJob} from '../src/revisions.js';
import {producePanels} from '../src/production.js';
import {runContinuityQA,assertContinuityQACurrent} from '../src/continuity-qa.js';
import {setContinuityOverride,effectiveContinuity} from '../src/continuity.js';

const image = 'data:image/png;base64,aGVsbG8=';

test('optional continuity survives import and feeds visual prompt without adding dialogue', async () => {
  const {project, file} = await fileFixture(2);
  file.plan.panels[0].continuity = {location:'体育館', props:['ボール']};
  file.plan.panels[1].continuity = {location:'体育館', storyIntent:'驚きの余韻', previousPanelId:'p1', props:['ボール'], hardConstraints:['汗を維持']};
  const candidate = await createNameCandidate(project, JSON.stringify(file));
  assert.equal(candidate.panels[1].continuity.previousPanelId, candidate.panels[0].id);
  const adopted = await adoptNameCandidate(project, candidate);
  const reloaded = JSON.parse(JSON.stringify(adopted));
  const request = imageRequest({panel:reloaded.panels[1], references:[], width:768, height:512, seed:1, instruction:''});
  assert.match(request.prompt, /驚きの余韻/);
  assert.match(request.prompt, /汗を維持/);
  assert.doesNotMatch(request.prompt, /「また明日」/);
  const legacy = structuredClone(file); delete legacy.plan.panels[0].continuity; delete legacy.plan.panels[1].continuity;
  assert.doesNotThrow(() => parseNameFile(JSON.stringify(legacy)));
});

test('continuity references reject unknown, future, different scene and non-cast states', async () => {
  const {project,file,atoms} = await fileFixture(2);
  for (const previousPanelId of ['missing','p2']) {
    const invalid=structuredClone(file); invalid.plan.panels[0].continuity={previousPanelId};
    await assert.rejects(createNameCandidate(project,invalid), error=>error.code==='continuity_previous');
  }
  const invalid=structuredClone(file); invalid.plan.panels[1].continuity={characters:[{id:'unseen',costume:'制服'}]};
  await assert.rejects(createNameCandidate(project,invalid), error=>error.code==='continuity_character');
  const otherScene=structuredClone(atoms); otherScene[1].source.sceneId='next-scene';
  const crossScene=structuredClone(file.plan); crossScene.panels[1].continuity={previousPanelId:'p1'};
  assert.throws(()=>validatePlan(crossScene,otherScene,[],otherScene),error=>error.code==='continuity_previous');
});

test('the accepted previous artwork hash is bound to the image job and rechecked at adoption', async () => {
  const {project,file}=await fileFixture(2);
  file.plan.panels[1].continuity={previousPanelId:'p1'};
  const candidate=await createNameCandidate(project,file);
  const adopted=await adoptNameCandidate(project,candidate);
  adopted.panels[0].image=image;
  const panel=adopted.panels[1];
  const execution=()=>({registry_id:'test',adapter_id:'test',model_id:'test'});
  const job=await beginJob(adopted,panel,'generate',null,execution,adopted.panels[0].id);
  assert.equal(job.continuity_reference.panelId,adopted.panels[0].id);
  const running={...adopted,jobs:[...adopted.jobs,job]};
  const generated={...panel,image,status:'review',attempts:1};
  const completed=await finishJob(running,job,generated);
  assert.equal(completed.jobs.at(-1).status,'complete');
  const changed={...running,panels:[{...running.panels[0],image:'data:image/png;base64,d29ybGQ='},panel]};
  const stale=await finishJob(changed,job,generated);
  assert.equal(stale.jobs.at(-1).status,'candidate');
});

test('sequential production passes the adopted same-scene image only when reference capacity remains', async () => {
  const {project,file}=await fileFixture(2);
  file.plan.panels[1].continuity={previousPanelId:'p1'};
  let current=await adoptNameCandidate(project,await createNameCandidate(project,file));
  current.panels[0].image=image;
  const calls=[];
  await producePanels({current:()=>current,commit:async next=>{current=typeof next==='function'?next(current):next},panelIds:current.panels.map(panel=>panel.id),
    generate:async (...args)=>{calls.push(args);return {...args[0],image,status:'review',attempts:1}}});
  assert.equal(calls.length,1);
  assert.equal(calls[0][11].continuityReference.id,current.panels[0].id);
  assert.equal(current.jobs.at(-1).status,'complete');
});

test('image-to-image QA is consent gated, reports without edits and rejects stale image hashes', async () => {
  const {project,file}=await fileFixture(2);
  file.plan.panels[1].continuity={previousPanelId:'p1',props:['ボール']};
  const adopted=await adoptNameCandidate(project,await createNameCandidate(project,file));
  adopted.panels.forEach(panel=>{panel.image=image;panel.artwork_revision=`art:${panel.id}`});
  await assert.rejects(runContinuityQA({project:adopted,panelId:adopted.panels[1].id,ask:async()=>({findings:[]})}),/送信許可/);
  const qa=await runContinuityQA({project:adopted,panelId:adopted.panels[1].id,imageCapable:true,ask:async args=>{
    assert.equal(args.images.length,2);
    return {findings:[{severity:'warning',evidence:'ボールが消えた',suggestion:'ボールを戻す'}]};
  }});
  assert.equal(qa.humanAccepted,false);
  assert.equal(qa.findings.length,1);
  await assertContinuityQACurrent(adopted,qa);
  const changed=structuredClone(adopted);changed.panels[0].image='data:image/png;base64,d29ybGQ=';
  await assert.rejects(assertContinuityQACurrent(changed,qa),/変わりました/);
});

test('oversized continuity is rejected before an image Job is reserved', async () => {
  const {project,file}=await fileFixture(1);
  file.plan.panels[0].continuity={hardConstraints:Array.from({length:12},(_,i)=>`${i}:${'長'.repeat(165)}`)};
  let current=await adoptNameCandidate(project,await createNameCandidate(project,file));
  await assert.rejects(producePanels({current:()=>current,commit:async next=>{current=next},panelIds:[current.panels[0].id],generate:async()=>{throw Error('should not send')}}),/長すぎます/);
  assert.equal(current.jobs.filter(job=>job.kind==='generate').length,0);
});

test('manual state lock takes priority, survives reload and can be removed with Undo history', async () => {
  const {project,file}=await fileFixture(2);
  file.plan.panels[1].continuity={previousPanelId:'p1',props:['古いバッグ']};
  const adopted=await adoptNameCandidate(project,await createNameCandidate(project,file));
  const target=adopted.panels[1];
  const locked=setContinuityOverride(adopted,target.id,{previousPanelId:null,characters:[],props:['新しいバッグ'],hardConstraints:['鞄を持つ']});
  const saved=JSON.parse(JSON.stringify(locked));
  assert.equal(effectiveContinuity(saved.panels[1]).previousPanelId,null);
  assert.match(imageRequest({panel:saved.panels[1],references:[],width:768,height:512,seed:1,instruction:''}).prompt,/新しいバッグ/);
  assert.doesNotMatch(imageRequest({panel:saved.panels[1],references:[],width:768,height:512,seed:1,instruction:''}).prompt,/古いバッグ/);
  assert.equal(saved.history.at(-1).nameEdit,true);
  const cleared=setContinuityOverride(saved,target.id,null);
  assert.equal(effectiveContinuity(cleared.panels[1]).props[0],'古いバッグ');
  assert.throws(()=>setContinuityOverride(adopted,target.id,{previousPanelId:'future',characters:[],props:[],hardConstraints:[]}),/既出コマ/);
});
