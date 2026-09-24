import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {embeddedV2ToEpisode} from '../contracts/name-plan/convert.mjs';
import {adoptPages, affectedByAppearance, buildPageEditContext, editNamePage, editNameScene, nameRevision, restoreNameRevision, splitEpisodeFiles, joinEpisodeFiles, resolvePanelDirection} from '../contracts/name-plan/page.mjs';
import {adoptNamePages, editProjectNamePage, restoreProjectNameRevision, saveNameRevision} from '../src/page-name.js';
import {finishJob,adoptCandidates} from '../src/revisions.js';
import {migrateSavedName} from '../src/page-name-legacy.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/name-parts-project.json',import.meta.url)));
const fresh=()=>embeddedV2ToEpisode(fixture.namePlan.file);

test('page edits, read-only context, scene appearance and whole-episode restore keep production',async()=>{
  const original=await fresh(),first=original.pageIds[0],page=original.pages[0];
  const second={id:'page-two',purpose:'後半',sourceExcerpts:[{id:'excerpt-two',text:'後半の原文'}],contextExcerpts:[],boundaryContext:{before:{text:'前半の出来事',relatedPageId:first},after:null},panels:[]};
  const two=structuredClone(original);two.pageIds.push(second.id);two.pages.push(second);
  const changed=editNamePage(two,first,[{type:'insertPanel',index:page.panels.length,panel:{id:'new-panel',sceneId:null,sourceExcerptIds:[],contextExcerptIds:[],beatIds:[],characters:[],texts:[],prompt:'',frame:null}}]);
  assert.deepEqual(changed.pages[1],second);
  assert.equal(changed.pages[0].panels.length,page.panels.length+1);
  const direction=resolvePanelDirection(two,first,page.panels[0].id);
  assert.equal(direction.pageId,first);
  const context=buildPageEditContext(two,second.id);
  assert.equal(context.previous.id,first);
  assert.equal(context.page.sourceExcerpts[0].text,'後半の原文');
  const sceneId=two.scenes[0].id,characterId='yumi';two.characters.push({id:characterId,name:'Yumi'});
  const withCostume=editNameScene(two,sceneId,[{type:'addAppearance',appearance:{id:'outfit-a',characterId,label:'夏服',costume:'白いシャツ'}}]);
  const withSelection=editNamePage(withCostume,first,[{type:'updatePanel',panelId:page.panels[0].id,changes:{characters:[{characterId,appearanceId:'outfit-a',visualState:'',emotion:'',holding:[]}]}}]);
  assert.equal(affectedByAppearance(withSelection,sceneId,'outfit-a')[0].panelId,page.panels[0].id);
  const before=nameRevision(withSelection,'変更前');
  const after=editNameScene(withSelection,sceneId,[{type:'updateAppearance',appearanceId:'outfit-a',changes:{costume:'青い上着'}}]);
  assert.equal(restoreNameRevision(after,before).scenes[0].appearances[0].costume,'白いシャツ');
  const project={...fixture,namePlan:null,otherNamePlans:[],panels:[],artworks:[{id:'art-a',panel:{image:'saved'}}],jobs:[{id:'job-a'}]};
  let adopted=adoptNamePages(project,two,two.pageIds);
  adopted=saveNameRevision(adopted,two.episodeId);
  const savedId=adopted.nameRevisions[JSON.stringify([two.workId,two.episodeId])][0].id;
  adopted=editProjectNamePage(adopted,two.episodeId,first,[{type:'removePanel',panelId:page.panels[0].id}]);
  adopted=restoreProjectNameRevision(adopted,two.episodeId,savedId);
  assert.equal(adopted.panels.length,two.pages.flatMap(p=>p.panels).length);
  assert.deepEqual(adopted.jobs,project.jobs);
  assert.deepEqual(adopted.artworks,project.artworks);
  assert.ok(adopted.nameRevisions[JSON.stringify([two.workId,two.episodeId])].length>=3);
});

test('partial transfer replaces only selected page; unselected or omitted pages stay',async()=>{
  const episode=await fresh(),id=episode.pageIds[0];
  episode.pageIds.push('page-later');episode.pages.push({id:'page-later',purpose:'後半',sourceExcerpts:[],contextExcerpts:[],panels:[]});
  const {manifest,pages}=splitEpisodeFiles(episode,[id]);
  const incoming=joinEpisodeFiles(manifest,pages);
  incoming.pages[0].purpose='改稿した前半';
  const adopted=adoptPages(episode,incoming,[id]);
  assert.deepEqual(adopted.pages.find(p=>p.id==='page-later'),episode.pages[1]);
  assert.equal(adopted.pages[0].purpose,'改稿した前半');
});

test('v3 generation stays a candidate through edits and cannot resurrect a deleted panel',async()=>{
  const image='data:image/png;base64,iVBORw0KGgo=';
  const panel={id:'test-panel',namePlanVersion:3,prompt:'before',characterIds:[],image:null,artwork_revision:null};
  const job={id:'job-1',panelId:panel.id,status:'running',kind:'generate',input_hash:'send-record',base_revision:null,started_at:Date.now()};
  const base={panels:[panel],jobs:[job],artworks:[],history:[]};
  const result=await finishJob(base,job,{...panel,image},false);
  assert.equal(result.jobs[0].status,'candidate');assert.equal(result.panels[0].image,null);
  const edited={...result,panels:[{...panel,prompt:'after'}]};
  const adopted=await adoptCandidates(edited,[job.id]);
  assert.equal(adopted.panels[0].prompt,'after');assert.equal(adopted.panels[0].image,image);
  await assert.rejects(adoptCandidates({...result,panels:[]},[job.id]),/削除済み/);
});

test('saved v2 hand edits migrate from current panels and frames, preserving IDs and jobs',()=>{
  const before=structuredClone(fixture);
  before.panels[0].prompt='手直し後の描写';
  const result=migrateSavedName(before,'P01');
  const episode=result.nameEpisodes[JSON.stringify([before.workId,'P01'])];
  assert.equal(episode.pages.flatMap(page=>page.panels)[0].prompt,'手直し後の描写');
  assert.deepEqual(new Set(result.panels.map(panel=>panel.id)),new Set(before.panels.map(panel=>panel.id)));
  assert.deepEqual(result.jobs,before.jobs);
  assert.ok(result.legacyNamePlans.length);
});
