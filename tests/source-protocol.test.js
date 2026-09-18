import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSourceManifest,referenceDeclarations,resolveRepositoryPath,mergeSourceReferences} from '../src/source-protocol.js';
const manifest = () => ({schema_version:1,episodes:[{id:'one',scene_ids:['s']}],scenes:[{id:'s',path:'text/first.md',tags:['駅',' 再会 ']}],references:{characters:[{name:'A',image:'portraits/a.png'}]}});
test('generic manifest describes arbitrary paths, optional settings, references and preserved tags',()=>{
 const raw=manifest(), model=normalizeSourceManifest(raw);assert.deepEqual(model.scenes,raw.scenes);assert.deepEqual(model.settings,[]);
 assert.deepEqual(referenceDeclarations(model,[]),[{name:'A',path:'portraits/a.png',alt:'A'}]);assert.deepEqual(raw,manifest());
});

test('story-source/v1 is validated once and projected without losing fixed IDs',()=>{
 const raw={format:'story-source/v1',work:{title:'共通作品'},episodes:[{id:'P01',title:'第一話',scenes:[{id:'P01-01',path:'manuscript/p01/p01-01.md',tags:['駅']}]}],settings:[{id:'WORLD',path:'settings/world.md'}],characters:[{id:'yu',name:'人物A',image:'assets/yu.png',description:'固定参照'}]};
 const model=normalizeSourceManifest(raw);
 assert.equal(model.format,'story-source/v1');assert.deepEqual(model.episodes[0].scene_ids,['P01-01']);
 assert.equal(model.scenes[0].episodeId,'P01');assert.equal(model.references[0].characterId,'yu');
 assert.equal(model.references[0].path,'assets/yu.png');assert.deepEqual(model.characters,raw.characters);
 assert.throws(()=>normalizeSourceManifest({...raw,episodes:[{...raw.episodes[0],scenes:[{...raw.episodes[0].scenes[0],path:'manuscript/p01/other.md'}]}]}),/story-source\/v1/);
 assert.throws(()=>normalizeSourceManifest({...raw,format:'story-source/v2'}),/未対応/);
});
test('schema 4 compatibility reads old character captions in any setting, structured declarations take precedence',()=>{
 const raw={...manifest(),schema_version:4};delete raw.references;
 const settings=[{id:'PEOPLE',path:'design/people.md',text:'![Aのキャラクター基準画](../pictures/a.jpg)\n![diagram](../pictures/map.png)'}];
 assert.deepEqual(referenceDeclarations(normalizeSourceManifest(raw),settings),[{name:'A',path:'pictures/a.jpg',alt:'Aのキャラクター基準画'}]);
 raw.references={characters:[]};assert.deepEqual(referenceDeclarations(normalizeSourceManifest(raw),settings),[]);
 assert.deepEqual(referenceDeclarations(normalizeSourceManifest({...raw,schema_version:1}),settings),[]);
 assert.throws(()=>resolveRepositoryPath('a.md','../secret.png'),/リポジトリ外/);
});
test('invalid versions, identities, tags, references and paths fail before file reads',()=>{
 for(const change of [{schema_version:99},{scenes:[{id:'s',path:'../private'}]},{scenes:[{id:'s',path:'a.md',tags:[' ']}]},{scenes:[{id:'s',path:'a.md',tags:Array(65).fill('x')}]},{scenes:[{id:'s',path:'a.md',tags:['x'.repeat(81)]}]},{episodes:[{id:'one',scene_ids:['missing']}]},{references:{characters:[{name:'A',image:'https://example.com/a.png'}]}},{references:{characters:[{name:'A',image:'a.png'},{name:'A',image:'b.png'}]}}]) assert.throws(()=>normalizeSourceManifest({...manifest(),...change}));
});
test('reference adoption keeps identity and revisions isolated by repository',()=>{
 const a=mergeSourceReferences([],[{name:'A',alt:'A',path:'p/a.png',image:'data',hash:'one'}],'owner/a','v1');
 const same=mergeSourceReferences(a,[{name:'A',alt:'A',path:'p/a.png',image:'data',hash:'one'}],'owner/a','v2');assert.equal(same[0].version,1);
 const other=mergeSourceReferences(same,[{name:'A',alt:'A',path:'p/a.png',image:'data',hash:'two'}],'owner/b','v3');assert.equal(other.length,2);assert.equal(other[0].source.repo,'owner/a');
});

test('story-source character IDs remain stable across image updates and reject ambiguous legacy names',()=>{
 const first=mergeSourceReferences([],[{id:'yu',characterId:'yu',name:'人物A',description:'設定',path:'assets/a.png',image:'data1',hash:'one'}],'owner/a','v1');
 const updated=mergeSourceReferences(first,[{id:'yu',characterId:'yu',name:'人物A',description:'更新設定',path:'assets/b.png',image:'data2',hash:'two'}],'owner/a','v2');
 assert.equal(updated.length,1);assert.equal(updated[0].id,'source:owner/a:yu');assert.equal(updated[0].source.id,'owner/a:yu');assert.equal(updated[0].source.character_id,'yu');assert.equal(updated[0].version,2);assert.equal(updated[0].description,'更新設定');
 const isolated=mergeSourceReferences(updated,[{id:'yu',characterId:'yu',name:'人物A',path:'assets/a.png',image:'data3',hash:'three'}],'owner/b','v3');assert.equal(isolated.length,2);
 assert.throws(()=>mergeSourceReferences([{id:'one',name:'人物A'},{id:'two',name:'人物A'}],[{name:'人物A',path:'a.png',image:'data',hash:'h'}],'owner/a','v4'),/複数/);
});
