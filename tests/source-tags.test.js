import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchingScenes,tagOptions,sceneTags,tagBlockSelection,panelSceneTags} from '../src/source-tags.js';
const snapshot={scenes:[{id:'a',tags:[' Rain ','ＲＡＩＮ','図書館']},{id:'b',tags:['雨']},{id:'c'}]};
test('export projection uses primary provenance, active tags, deleted-scene history and no raw source',()=>{
 const project={active:'new',snapshots:[{id:'old',repo:'x/y',scenes:[{id:'A',tags:['old'],text:'SECRET'},{id:'B',tags:['historic']}]},{id:'new',repo:'x/y',scenes:[{id:'A',tags:['new']},{id:'context',tags:['exclude']}]}]};
 const panels=[{id:'p',sourceRefs:[{snapshotId:'old',sceneId:'A'},{snapshotId:'old',sceneId:'B'}],contextRefs:[{snapshotId:'new',sceneId:'context'}]},{id:'manual'}];
 const before=structuredClone({project,panels});
 assert.deepEqual(panelSceneTags(project,panels),[{panelId:'p',scenes:[{id:'A',tags:['new']},{id:'B',tags:['historic']}]},{panelId:'manual',scenes:[]}]);
 assert.deepEqual({project,panels},before);
 project.snapshots[0].repo='other/repo';assert.throws(()=>panelSceneTags(project,panels),/別作品/);
});
test('normalization is derived, stable, deduplicated and scene-local',()=>{
 const before=structuredClone(snapshot);
 assert.deepEqual(tagOptions(snapshot).map(x=>x.label),[' Rain ','図書館','雨']);
 assert.deepEqual(matchingScenes(snapshot,['rain','図書館'],'all'),['a']);
 assert.deepEqual(matchingScenes(snapshot,['雨','図書館'],'all'),[]);
 assert.deepEqual(matchingScenes(snapshot,['雨','図書館'],'any'),['a','b']);
 assert.deepEqual(matchingScenes(snapshot),['a','b','c']);assert.deepEqual(snapshot,before);
 assert.deepEqual(sceneTags({scenes:[{id:'x'}],manifest:{scenes:[{id:'x',tags:['tag']},{id:'other',tags:['secret']}]}},'x'),['tag']);
 assert.deepEqual(sceneTags({scenes:[],manifest:{scenes:[{id:'x',tags:['secret']}]}},'x'),[]);
});
test('selection expands dependent groups only for confirmation and excludes pending groups',()=>{
 const changes={blocks:[{id:'1',groupId:'g'},{id:'2',groupId:'g'},{id:'3',groupId:'h'}]};
 const rows=changes.blocks.map((block,i)=>({block:{...block,newRefs:[{sceneId:['a','b','c'][i]}]},oldRefs:[]}));
 assert.deepEqual(tagBlockSelection(changes,rows,['a']),{ids:['1','2'],additional:['b']});
 assert.deepEqual(tagBlockSelection(changes,rows,['a'],['2']),{ids:[],additional:[]});
 assert.deepEqual(tagBlockSelection(changes,rows,['a','c']),{ids:['1','2','3'],additional:['b']});
});
