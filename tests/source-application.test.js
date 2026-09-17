import {test} from 'node:test';import assert from 'node:assert/strict';
import {upgradeSourceProject,validateApplication,buildAffectedScope} from '../src/source-application.js';
const fixture=()=>({version:4,active:'new',snapshots:[{id:'old',scenes:[{id:'s',text:'日本😀\n\n旧B'}]},{id:'new',scenes:[{id:'s',text:'追加\n\n日本😀\n\n新B'}]}],panels:[{id:'p',snapshotId:'old',sceneId:'s',unitIds:['s:u0','s:u1'],image:'existing'}],history:[],layout:{pages:[{id:'page',slots:[{panelId:'p'}]}]}});
test('legacy migration fixes ranges to the original snapshot, preserves geometry/art, and is idempotent',async()=>{
 const old=fixture(),next=await upgradeSourceProject(old);assert.equal(old.version,4);assert.equal(next.version,5);assert.equal(next.panels[0].image,'existing');assert.deepEqual(next.layout,old.layout);assert.equal(next.sourceApplication.units.length,2);assert.equal(next.panels[0].sourceRefs[0].snapshotId,'old');assert.equal(next.panels[0].sourceRefs[0].startCp,0);assert.deepEqual(await upgradeSourceProject(next),next);assert.equal(validateApplication(next),true);
 const scope=buildAffectedScope(next,[{oldUnitIds:[next.sourceApplication.units[0].id]}]);assert.deepEqual(scope.contentPanelIds,['p']);assert.deepEqual(scope.layoutIntervals,[{start:0,end:1}]);
});
test('missing source and partial art are never silently treated as applied',async()=>{
 const old=fixture();old.panels[0].unitIds.push('s:u99');const next=await upgradeSourceProject(old);assert.deepEqual(next.panels,old.panels);assert.equal(next.sourceApplication.units.length,0);assert.equal(next.sourceDiagnostics.length,1);
 const partial=fixture();delete partial.panels[0].image;assert.equal((await upgradeSourceProject(partial)).sourceApplication.units.length,0);
});
test('split dialogue preserves exact coverage and rejects duplicate or omitted letters',async()=>{
 const next=await upgradeSourceProject(fixture()),p=next.panels[0],ref=p.lettering.boxes[0].sourceRefs[0];p.lettering.boxes.splice(0,1,{...p.lettering.boxes[0],id:'a',sourceRefs:[{...ref,endCp:1}]},{...p.lettering.boxes[0],id:'b',sourceRefs:[{...ref,startCp:1}]});assert.equal(validateApplication(next),true);
 const duplicate=structuredClone(next);duplicate.panels[0].lettering.boxes.push(duplicate.panels[0].lettering.boxes[0]);assert.throws(()=>validateApplication(duplicate),/欠落・重複/);
 p.lettering.boxes.shift();assert.throws(()=>validateApplication(next),/欠落・重複/);
});
test('applied content requires unique placement and reference reading order, even for repeated text',async()=>{
 const next=await upgradeSourceProject(fixture());next.layout.pages[0].slots=[];assert.throws(()=>validateApplication(next),/配置/);
 const p=await upgradeSourceProject(fixture());p.sourceApplication.units.reverse();assert.throws(()=>validateApplication(p),/読書順/);
});
