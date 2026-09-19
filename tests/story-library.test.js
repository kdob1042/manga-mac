import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchStoryLibrary,fetchStoryLibraryWork,libraryManifestLocation,manifestOutline,validateLibraryCatalog} from '../src/story-library.js';

const sha='a'.repeat(40);
const catalog={format:'story-library/v1',authorityUntil:'M8',works:[
 {id:'work-a',title:'作品A',root:'works/work-a',formats:['manga'],manuscriptFormat:'story-source/v1',readAdapters:['story-source/v1'],authority:'origin',origin:{repository:'owner/a',ref:'main',commit:'b'.repeat(40),manifestPath:'manifest.json',accessible:true},importStatus:'imported'},
 {id:'work-b',title:'作品B',root:'works/work-b',formats:['novel'],manuscriptFormat:'investor-life-source/v1',readAdapters:['investor-life-source/v1'],authority:'origin',origin:{repository:'owner/b',ref:'main',commit:'c'.repeat(40),manifestPath:'manifest.json',accessible:true},importStatus:'imported'}
]};
const sourceMap={format:'story-library-source-map/v1',authority:'origin',entries:[
 {workId:'work-a',origin:{repository:'owner/a'},target:{root:'works/work-a'}},
 {workId:'work-b',origin:{repository:'owner/b'},target:{root:'works/work-b'}}
]};

test('uses the story-library validator and keeps fixed work roots',()=> {
 const normalized=validateLibraryCatalog(catalog);
 assert.deepEqual(normalized.works.map(work=>work.id),['work-a','work-b']);
 assert.equal(libraryManifestLocation(normalized.works[0]).manifestPath,'works/work-a/source/manifest.json');
 assert.throws(()=>validateLibraryCatalog({...catalog,works:[{...catalog.works[0],root:'works/../escape'}]}));
});

test('fetches catalog, source-map and selected manifest at one immutable commit',async()=> {
 const calls=[];
 const invoke=async(command,args)=> {
  calls.push({command,args});
  if(command==='github_get')return JSON.stringify({sha});
  if(command==='github_file'&&args.path==='library.json')return JSON.stringify(catalog);
  if(command==='github_file'&&args.path==='migrations/source-map.json')return JSON.stringify(sourceMap);
  if(command==='github_file'&&args.path==='works/work-b/source/manifest.json')return JSON.stringify({format:'investor-life-source/v1',work:{title:'作品B'},chapters:[{id:'C01',title:'章',episodes:[{id:'C01-E01',title:'話',path:'manuscript/p01/p01-01.md'}]}],settings:[]});
  throw Error('unexpected request ' + args.path);
 };
 const library=await fetchStoryLibrary('owner/library','token',invoke);
 const selected=await fetchStoryLibraryWork(library,'work-b','token',invoke);
 assert.equal(library.sha,sha);
 assert.equal(selected.manifestPath,'works/work-b/source/manifest.json');
 assert.equal(selected.outline[0].id,'C01-E01');
 assert.deepEqual(calls.filter(call=>call.command==='github_file').map(call=>[call.args.path,call.args.sha]),[
  ['library.json',sha],['migrations/source-map.json',sha],['works/work-b/source/manifest.json',sha]
 ]);
});

test('outline supports the canonical nested episode shape',()=> {
 const outline=manifestOutline({format:'story-source/v1',episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'},{id:'P01-02',path:'manuscript/p01/p01-02.md'}]}],settings:[],characters:[],work:{title:'作品'}});
 assert.deepEqual(outline[0].scenes.map(scene=>scene.id),['P01-01','P01-02']);
});
