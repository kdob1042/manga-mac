import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchStoryLibrary,fetchStoryLibraryWork,manifestOutline,validateLibraryCatalog} from '../src/story-library.js';

const sha='a'.repeat(40);
const catalog={format:'story-library/v1',authorityUntil:'M8',works:[
 {id:'work-a',title:'作品A',root:'works/work-a',formats:['manga'],manuscriptFormat:'story-source/v1',readAdapters:['story-source/v1'],authority:'origin',origin:{repository:'owner/a',ref:'main',commit:'b'.repeat(40),manifestPath:'source/manifest.json',accessible:true}},
 {id:'work-b',title:'作品B',root:'works/work-b',formats:['novel'],manuscriptFormat:'investor-life-source/v1',readAdapters:['investor-life-source/v1'],authority:'origin',origin:{repository:'owner/b',ref:'main',commit:'c'.repeat(40),manifestPath:'source/manifest.json',accessible:true}},
]};

test('validates catalog roots and keeps fixed work IDs',()=> {
 const normalized=validateLibraryCatalog(catalog);
 assert.deepEqual(normalized.works.map(work=>work.id),['work-a','work-b']);
 assert.equal(normalized.works[0].root,'works/work-a');
 assert.throws(()=>validateLibraryCatalog({...catalog,works:[{...catalog.works[0],root:'works/../escape'}]}),/作品root/);
});

test('fetches catalog and selected manifest at the same immutable commit',async()=> {
 const calls=[];
 const invoke=async(command,args)=> {
  calls.push({command,args});
  if(command==='github_get')return JSON.stringify({sha});
  if(command==='github_file'&&args.path==='library.json')return JSON.stringify(catalog);
  if(command==='github_file'&&args.path==='works/work-b/source/manifest.json')return JSON.stringify({format:'investor-life-source/v1',work:{title:'作品B'},chapters:[{id:'C01',title:'章',episodes:[{id:'C01-E01',title:'話',path:'manuscript/p01/p01-01.md'}]}],settings:[]});
  throw Error('unexpected request');
 };
 const library=await fetchStoryLibrary('owner/library','token',invoke);
 const selected=await fetchStoryLibraryWork(library,'work-b','token',invoke);
 assert.equal(library.sha,sha);assert.equal(selected.manifestPath,'works/work-b/source/manifest.json');assert.equal(selected.outline[0].id,'C01-E01');
 assert.deepEqual(calls.map(call=>[call.command,call.args.path,call.args.sha]),[['github_get','commits/main',undefined],['github_file','library.json',sha],['github_file','works/work-b/source/manifest.json',sha]]);
});

test('outline supports the canonical nested episode shape',()=> {
 const outline=manifestOutline({format:'story-source/v1',episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01'},{id:'P01-02'}]}]});
 assert.deepEqual(outline[0].scenes.map(scene=>scene.id),['P01-01','P01-02']);
});
