import {test} from 'node:test';import assert from 'node:assert/strict';
import {sourceSummary} from '../src/source-sync.js';
import {syncSource} from '../src/pipeline.js';
test('import summary reports deletions, settings and image changes but ignores commit-only changes',()=>{
 const a={id:'a',sha:'a',manifest:{work:'A'},scenes:[{id:'S1',text:'A'},{id:'S2',text:'B'}],settings:[{id:'V',text:'x'}],references:[{path:'a.png',hash:'a'}]};
 assert.equal(sourceSummary(a,{...a,id:'b',sha:'b'}).changed,false);
 const b={...a,scenes:[{id:'S1',text:'C'}],settings:[{id:'V',text:'y'}],references:[{path:'a.png',hash:'b'}]};
 assert.deepEqual(sourceSummary(a,b).scenes,['変更: S1','削除: S2']);assert.deepEqual(sourceSummary(a,b).settings,['変更: V']);assert.deepEqual(sourceSummary(a,b).references,['変更: a.png']);
 assert.equal(sourceSummary(null,a).changed,true);
});

test('import summary includes story-source character IDs and descriptions',()=>{
 const a={manifest:{format:'story-source/v1'},scenes:[],settings:[],characters:[{id:'yu',name:'人物A',image:'assets/a.png',description:'旧'}],references:[{characterId:'yu',path:'assets/a.png',hash:'one',name:'人物A'}]};
 const b={manifest:{format:'story-source/v1'},scenes:[],settings:[],characters:[{id:'yu',name:'人物A',image:'assets/b.png',description:'新'}],references:[{characterId:'yu',path:'assets/b.png',hash:'two',name:'人物A',description:'新'}]};
 const summary=sourceSummary(a,b);assert.deepEqual(summary.references,['変更: yu']);assert.equal(summary.changed,true);
});

test('story-source/v1 sync reads declared paths from one pinned commit',async()=>{
 const manifest={format:'story-source/v1',work:{title:'共通作品'},episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md',tags:['駅']}]}],settings:[{id:'WORLD',path:'settings/world.md'}],characters:[{id:'yu',name:'人物A',image:'assets/yu.png',description:'固定参照'}]};
 const calls=[];
 const invoke=async(command,args)=>{
  calls.push({command,args});
  if(command==='github_get')return JSON.stringify({sha:'c'.repeat(40)});
  if(command==='github_file'){
   const files={'manifest.json':JSON.stringify(manifest),'manuscript/p01/p01-01.md':'# 場面\n\n本文です','settings/world.md':'# 世界\n\n設定です'};
   if(!(args.path in files))throw Error(`unexpected file ${args.path}`);return files[args.path];
  }
  if(command==='github_asset')return {image:'data:image/png;base64,AAAA',hash:'h'.repeat(64)};
  throw Error(`unexpected command ${command}`);
 };
 const snapshot=await syncSource('owner/story','token','P01',null,invoke);
 assert.equal(snapshot.protocol.format,'story-source/v1');assert.equal(snapshot.sync.manifest_path,'manifest.json');
 assert.equal(snapshot.scenes[0].id,'P01-01');assert.equal(snapshot.settings[0].id,'WORLD');assert.equal(snapshot.references[0].characterId,'yu');
 assert.deepEqual(calls.filter(call=>call.command==='github_file').map(call=>call.args.path),['manifest.json','manuscript/p01/p01-01.md','settings/world.md']);
 assert.equal(calls.find(call=>call.command==='github_asset').args.path,'assets/yu.png');
});

test('story-source/v1 source-root entrypoint keeps manifest paths source-relative',async()=>{
 const manifest={format:'story-source/v1',work:{title:'source root'},episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'}]}],settings:[],characters:[]};
 const paths=[];
 const invoke=async(command,args)=>{
  if(command==='github_get')return JSON.stringify({sha:'d'.repeat(40)});
  if(command==='github_file'){
   paths.push(args.path);
   if(args.path==='manifest.json')throw Error('404');
   if(args.path==='source/manifest.json')return JSON.stringify(manifest);
   if(args.path==='source/manuscript/p01/p01-01.md')return '# 場面\n\n本文';
  }
  throw Error(`unexpected ${command} ${args.path}`);
 };
 const snapshot=await syncSource('owner/source','token','P01',null,invoke);
 assert.equal(snapshot.sync.manifest_path,'source/manifest.json');assert.deepEqual(paths,['manifest.json','source/manifest.json','source/manuscript/p01/p01-01.md']);
});

test('library sync pins catalog, manifest, body and assets to the supplied commit', async()=> {
 const sha='e'.repeat(40), manifest={format:'investor-life-source/v1',work:{title:'投資家'},chapters:[{id:'C01',title:'章',episodes:[{id:'C01-E01',title:'話',path:'manuscript/p01/p01-01.md'}]}],settings:[{id:'WORLD',path:'settings/world.md'}]};
 const calls=[];
 const invoke=async(command,args)=>{
  calls.push({command,args});
  if(command==='github_file'){
   const files={'works/investor-life/source/manifest.json':JSON.stringify(manifest),'works/investor-life/manuscript/p01/p01-01.md':'# ［C01-E01］ 話\\n\\n本文','works/investor-life/settings/world.md':'# 世界\\n\\n設定'};
   if(!(args.path in files))throw Error(`unexpected file ${args.path}`);
   return files[args.path];
  }
  throw Error(`unexpected ${command}`);
 };
 const snapshot=await syncSource('owner/story','token','C01-E01',null,invoke,{commit:sha,workId:'investor-life',workRoot:'works/investor-life',manifestPath:'works/investor-life/source/manifest.json',sourceRoot:'works/investor-life',format:'investor-life-source/v1'});
 assert.equal(snapshot.workId,'investor-life');assert.equal(snapshot.library.commit,sha);assert.equal(snapshot.protocol.format,'investor-life-source/v1');
 assert.deepEqual(calls.filter(call=>call.command==='github_get'),[]);
 assert.deepEqual(calls.filter(call=>call.command==='github_file').map(call=>call.args.path),['works/investor-life/source/manifest.json','works/investor-life/manuscript/p01/p01-01.md','works/investor-life/settings/world.md']);
});
