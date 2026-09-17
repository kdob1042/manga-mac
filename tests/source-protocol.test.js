import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSourceManifest,referenceDeclarations,resolveRepositoryPath,mergeSourceReferences} from '../src/source-protocol.js';
const manifest = () => ({schema_version:1,episodes:[{id:'one',scene_ids:['s']}],scenes:[{id:'s',path:'text/first.md',tags:['駅',' 再会 ']}],references:{characters:[{name:'A',image:'portraits/a.png'}]}});
test('generic manifest describes arbitrary paths, optional settings, references and preserved tags',()=>{
 const raw=manifest(), model=normalizeSourceManifest(raw);assert.deepEqual(model.scenes,raw.scenes);assert.deepEqual(model.settings,[]);
 assert.deepEqual(referenceDeclarations(model,[]),[{name:'A',path:'portraits/a.png',alt:'A'}]);assert.deepEqual(raw,manifest());
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
