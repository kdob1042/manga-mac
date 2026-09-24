import {test} from 'node:test';import assert from 'node:assert/strict';
import {sourceSummary} from '../src/source-sync.js';
import {syncSource} from '../src/pipeline.js';
test('import summary reports content and commit-only changes for pinned name-plan updates',()=>{
 const a={id:'a',sha:'a',manifest:{work:'A'},scenes:[{id:'S1',text:'A'},{id:'S2',text:'B'}],settings:[{id:'V',text:'x'}],references:[{path:'a.png',hash:'a'}]};
 assert.deepEqual(sourceSummary(a,{...a,id:'b',sha:'b'}).versionChanged,true);
 assert.equal(sourceSummary(a,{...a,id:'b',sha:'b'}).changed,true);
 assert.equal(sourceSummary(a,{...a}).changed,false);
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

test('imports manuscript while recording a declared image with invalid bytes',async()=>{
 const sha='e'.repeat(40);
 const manifest={format:'story-source/v1',work:{title:'作品'},episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'}]}],settings:[],characters:[
  {id:'yu',name:'人物A',image:'assets/yu.png'},
  {id:'chihiro',name:'人物B',image:'assets/chihiro.jpg'},
 ]};
 const invoke=async(command,args)=>{
  if(command==='github_file')return args.path==='manifest.json'?JSON.stringify(manifest):'# 第一場面\n\n本文';
  if(command==='github_asset'){
   if(args.path==='assets/chihiro.jpg')throw Error('参照画像の実形式がPNG/JPEG/WebPではありません');
   return {image:'data:image/png;base64,AAAA',hash:'f'.repeat(64),mime:'image/png',size:4};
  }
  throw Error(command);
 };
 const snapshot=await syncSource('owner/story','','P01',null,invoke,{commit:sha,branch:'dev'});
 assert.deepEqual(snapshot.scenes.map(scene=>scene.id),['P01-01']);
 assert.deepEqual(snapshot.references.map(reference=>reference.characterId),['yu']);
 assert.deepEqual(snapshot.unavailableReferences,[{name:'人物B',path:'assets/chihiro.jpg',reason:'invalid_image_format'}]);
 await assert.rejects(syncSource('owner/story','','P01',null,async(command,args)=>{
  if(command==='github_asset')throw Error('connection failed');
  return invoke(command,args);
 },{commit:sha,branch:'dev'}),/connection failed/);
});

test('legacy source entrypoint still resolves declared paths from the work root',async()=>{
 const manifest={format:'story-source/v1',work:{title:'source root'},episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'}]}],settings:[],characters:[]};
 const paths=[];
 const invoke=async(command,args)=>{
  if(command==='github_get')return JSON.stringify({sha:'d'.repeat(40)});
  if(command==='github_file'){
   paths.push(args.path);
   if(args.path==='manifest.json')throw Error('404');
   if(args.path==='source/manifest.json')return JSON.stringify(manifest);
   if(args.path==='manuscript/p01/p01-01.md')return '# 場面\n\n本文';
  }
  throw Error(`unexpected ${command} ${args.path}`);
 };
 const snapshot=await syncSource('owner/source','token','P01',null,invoke);
 assert.equal(snapshot.sync.manifest_path,'source/manifest.json');assert.deepEqual(paths,['manifest.json','work.json','source/manifest.json','manuscript/p01/p01-01.md']);
});

test('library sync pins catalog, manifest, body and assets to the supplied commit', async()=> {
 const sha='e'.repeat(40), manifest={format:'investor-life-source/v1',work:{title:'投資家'},chapters:[{id:'C01',title:'章',episodes:[{id:'C01-E01',title:'話',path:'manuscript/p01/p01-01.md'}]}],settings:[{id:'WORLD',path:'settings/world.md'}]};
 const calls=[];
 const invoke=async(command,args)=>{
  calls.push({command,args});
  if(command==='github_file'){
   const files={'works/investor-life/work.json':JSON.stringify(manifest),'works/investor-life/manuscript/p01/p01-01.md':'# ［C01-E01］ 話\\n\\n本文','works/investor-life/settings/world.md':'# 世界\\n\\n設定'};
   if(!(args.path in files))throw Error(`unexpected file ${args.path}`);
   return files[args.path];
  }
  throw Error(`unexpected ${command}`);
 };
 const snapshot=await syncSource('owner/story','token','C01-E01',null,invoke,{commit:sha,workId:'investor-life',workRoot:'works/investor-life',manifestPath:'works/investor-life/work.json',sourceRoot:'works/investor-life',format:'investor-life-source/v1'});
 assert.equal(snapshot.workId,'investor-life');assert.equal(snapshot.library.commit,sha);assert.equal(snapshot.protocol.format,'investor-life-source/v1');
 assert.deepEqual(calls.filter(call=>call.command==='github_get'),[]);
 assert.deepEqual(calls.filter(call=>call.command==='github_file').map(call=>call.args.path),['works/investor-life/work.json','works/investor-life/manuscript/p01/p01-01.md','works/investor-life/settings/world.md']);
});

test('library scene selection reads one scene and keys the snapshot by scene',async()=>{
 const sha='f'.repeat(40);
 const manifest={format:'story-source/v1',work:{title:'作品'},episodes:[{id:'P01',title:'第一話',scenes:[
  {id:'P01-01',path:'manuscript/p01/p01-01.md'},
  {id:'P01-02',path:'manuscript/p01/p01-02.md'}
 ]}],settings:[],characters:[]};
 const paths=[];
 const invoke=async(command,args)=>{
  if(command==='github_file'){
   paths.push(args.path);
   const files={
    'works/work/work.json':JSON.stringify(manifest),
    'works/work/manuscript/p01/p01-01.md':'# 第一場面\n\n本文1',
    'works/work/manuscript/p01/p01-02.md':'# 第二場面\n\n本文2'
   };
   if(!(args.path in files)) throw Error('unexpected file '+args.path);
   return files[args.path];
  }
  throw Error('unexpected command '+command);
 };
 const snapshot=await syncSource('owner/story','token','P01',null,invoke,{
  commit:sha,workId:'work',workRoot:'works/work',sourceRoot:'works/work',
  manifestPath:'works/work/work.json',sceneId:'P01-02'
 });
 assert.deepEqual(snapshot.scenes.map(scene=>scene.id),['P01-02']);
 assert.match(snapshot.id,/P01-02$/);
 assert.deepEqual(paths,['works/work/work.json','works/work/manuscript/p01/p01-02.md']);
});


test('multi-episode sync retains previously imported episodes and reads selected branch head',async()=>{
 const manifest={format:'story-source/v1',work:{title:'複数話'},episodes:[
  {id:'P01',title:'一',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md'}]},
  {id:'P02',title:'二',scenes:[{id:'P02-01',path:'manuscript/p02/p02-01.md'}]}
 ],settings:[],characters:[]};
 const firstSha='1'.repeat(40),secondSha='2'.repeat(40),heads=[];
 const invoke=async(command,args)=>{
  if(command==='github_get'){heads.push(args.path);return JSON.stringify({sha:firstSha});}
  if(command==='github_file'){
   if(args.path==='manifest.json')return JSON.stringify(manifest);
   if(args.path==='manuscript/p01/p01-01.md')return '# P01\n\n本文1';
   if(args.path==='manuscript/p02/p02-01.md')return '# P02\n\n本文2';
  }
  throw Error('unexpected '+command+' '+args.path);
 };
 const first=await syncSource('owner/story','token','P01',null,invoke,{branch:'dev',episodeIds:['P02','P01']});
 assert.deepEqual(first.episodeIds,['P01','P02']);assert.equal(first.sync.source_branch,'dev');
 assert.deepEqual(first.scenes.map(scene=>scene.id),['P01-01','P02-01']);assert.deepEqual(heads,['commits/dev']);
 const update=async(command,args)=>{
  if(command==='github_file'){
   if(args.path==='manifest.json')return JSON.stringify(manifest);
   if(args.path==='manuscript/p01/p01-01.md')return '# P01\n\n本文1更新';
   if(args.path==='manuscript/p02/p02-01.md')return '# P02\n\n本文2更新';
  }
  throw Error('unexpected '+command+' '+args.path);
 };
 const second=await syncSource('owner/story','token','P02',first,update,{branch:'dev',commit:secondSha,episodeIds:['P02']});
 assert.deepEqual(second.episodeIds,['P01','P02']);
 assert.deepEqual(second.scenes.map(scene=>scene.id),['P01-01','P02-01']);
 assert.match(second.scenes[0].text,/更新/);assert.match(second.scenes[1].text,/更新/);
});
