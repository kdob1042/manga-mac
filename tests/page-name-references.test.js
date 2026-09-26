import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {embeddedV2ToEpisode} from '../contracts/name-plan/convert.mjs';
import {adoptNamePages,adoptRepositoryNamePages,editProjectNamePage} from '../src/page-name.js';
import {fetchPageNameReferences} from '../src/name-repository.js';
import {producePanels} from '../src/production.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/name-parts-project.json',import.meta.url)));
const image='data:image/png;base64,iVBORw0KGgo=',hash='a'.repeat(64),repo='fixture/stories';
async function example(){
  const episode=await embeddedV2ToEpisode(fixture.namePlan.file);
  episode.characters=[{id:'yumi',name:'由美子'}];
  episode.pages[0].panels[0].characters=[{characterId:'yumi',appearanceId:null,visualState:'',emotion:'',holding:[]}];
  const project={...structuredClone(fixture),namePlan:null,otherNamePlans:[],panels:[],characters:[],workId:episode.workId};
  return {episode,project};
}
const referenceImport=()=>({repo,root:'works/example',sha:'b'.repeat(40),references:[{characterId:'yumi',name:'由美子',path:'assets/yumi.png',image,hash}]});

test('v3 binds old source references without duplicating people or rewriting portable names',async()=>{
  const {episode,project}=await example(),id=`source:${repo}#${episode.workId}:yumi`;
  project.characters=[{id,name:'由美子',image,hash,version:2,source:{repo,scope:`${repo}#${episode.workId}`,character_id:'yumi'}}];
  project.snapshots=[{id:'source',workId:episode.workId,repo}];project.active='source';
  const before=structuredClone(project);
  const result=adoptNamePages(project,episode,episode.pageIds);
  assert.deepEqual(project,before);assert.equal(result.characters.length,1);
  assert.deepEqual(result.panels[0].characterIds,[id]);assert.equal(result.panels[0].continuity.characters[0].id,id);
  assert.equal(result.nameEpisodes[JSON.stringify([episode.workId,episode.episodeId])].characters[0].id,'yumi');
  const edited=editProjectNamePage(JSON.parse(JSON.stringify(result)),episode.episodeId,episode.pageIds[0],[{type:'updatePanel',panelId:result.panels[0].id,changes:{prompt:'修正'}}]);
  assert.deepEqual(edited.panels[0].characterIds,[id]);assert.equal(edited.characters.length,1);
  assert.deepEqual(edited.jobs,project.jobs);assert.deepEqual(edited.artworks,project.artworks);
});

test('fresh GitHub adoption registers references automatically and preserves existing source IDs on reimport',async()=>{
  const {episode,project}=await example();
  let result=adoptRepositoryNamePages(project,episode,episode.pageIds,referenceImport());
  const id=result.panels[0].characterIds[0];
  assert.equal(result.characters.length,1);assert.equal(result.characters[0].image,image);
  assert.equal(result.characters[0].source.character_id,'yumi');
  result=adoptRepositoryNamePages(result,episode,episode.pageIds,referenceImport());
  assert.equal(result.characters.length,1);assert.equal(result.panels[0].characterIds[0],id);
  assert.equal(result.characters[0].version,1);
});

test('empty placeholders use existing references; another work or repo is never matched by name',async()=>{
  const {episode,project}=await example();project.snapshots=[{id:'source',workId:episode.workId,repo}];project.active='source';
  project.characters=[{id:'yumi',name:'由美子',image:null,hash:''},{id:'correct',name:'由美子',image,hash,source:{repo,scope:`${repo}#${episode.workId}`,character_id:'yumi'}}];
  assert.deepEqual(adoptNamePages(project,episode,episode.pageIds).panels[0].characterIds,['correct']);
  project.characters[1].source.repo='another/repo';
  assert.deepEqual(adoptNamePages(project,episode,episode.pageIds).panels[0].characterIds,['yumi']);
  project.characters[1].source.repo=repo;project.characters[1].source.scope=`${repo}#another-work`;
  assert.deepEqual(adoptNamePages(project,episode,episode.pageIds).panels[0].characterIds,['yumi']);
  project.characters=[{id:'yumi',name:'由美子',image,hash,source:{repo:'other/repo',scope:'other/repo#example',character_id:'yumi'}}];
  assert.throws(()=>adoptNamePages(project,episode,episode.pageIds),/衝突/);
});

test('reference import never reuses an unrelated same-name manual character',async()=>{
  const {episode,project}=await example();
  project.characters=[{id:'unrelated',name:'由美子',image,hash}];
  const result=adoptRepositoryNamePages(project,episode,episode.pageIds,referenceImport());
  assert.equal(result.characters.length,2);assert.notEqual(result.panels[0].characterIds[0],'unrelated');
  assert.deepEqual(result.characters[0],project.characters[0]);
});

test('page reference transport freezes commit, reads only needed declared images and never manuscript',async()=>{
  const {episode}=await example(),index={repo,root:`works/${episode.workId}`,sha:'c'.repeat(40)},calls=[];
  const manifest={format:'story-source/v1',work:{title:'fixture'},episodes:[{id:'P01',title:'話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'}]}],settings:[],characters:[{id:'yumi',name:'由美子',image:'assets/yumi.png'},{id:'unused',name:'別人',image:'assets/unused.png'}]};
  const result=await fetchPageNameReferences(index,episode,'memory-only',async(command,args)=>{
    calls.push([command,args]);index.sha='d'.repeat(40);
    return command==='github_file'?JSON.stringify(manifest):{image,hash};
  });
  assert.equal(result.sha,'c'.repeat(40));assert.equal(result.references.length,1);
  assert.deepEqual(calls.map(([command,args])=>[command,args.path,args.sha]),[
    ['github_file',`works/${episode.workId}/work.json`,'c'.repeat(40)],
    ['github_asset',`works/${episode.workId}/assets/yumi.png`,'c'.repeat(40)]
  ]);
  assert.equal(JSON.stringify(result).includes('memory-only'),false);
  await assert.rejects(fetchPageNameReferences({...index,root:'works/other'},episode,'',()=>assert.fail()),/作品ID/);
});

test('missing reference blocks v3 production explicitly before any job or generation',async()=>{
  const {episode,project}=await example(),adopted=adoptNamePages(project,episode,episode.pageIds);
  await assert.rejects(producePanels({current:()=>adopted,commit:()=>assert.fail(),generate:()=>assert.fail(),panelIds:[adopted.panels[0].id]}),/参照画像がありません/);
});
