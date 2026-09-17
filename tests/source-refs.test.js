import {test} from 'node:test';import assert from 'node:assert/strict';
import {codePointMap,resolveSourceRef,tokenizeSnapshot,legacyPanelRefs,covers,sourcePages} from '../src/source-refs.js';
test('Unicode scalar references preserve Japanese, emoji, combining marks and CRLF exactly',()=>{
 const snapshot={id:'old',scenes:[{id:'s',text:'# 見出し\r\n\r\n日本😀e\u0301\r\n次行\r\n\r\n末尾'}]};const u=tokenizeSnapshot(snapshot);
 assert.equal(u[0].text,'日本😀e\u0301\r\n次行\r');assert.equal(resolveSourceRef([snapshot],u[0].source),u[0].text);
 assert.deepEqual(legacyPanelRefs({snapshotId:'old',sceneId:'s',unitIds:['s:u1']},[snapshot]),[u[0].source]);
 assert.throws(()=>codePointMap('\ud800'),/Unicode/);assert.throws(()=>resolveSourceRef([snapshot],{...u[0].source,endCp:999}),/不正/);
 const ref={...u[0].source,endCp:u[0].source.startCp+3};assert.equal(resolveSourceRef([snapshot],ref),'日本😀');
});
test('split refs cover once, visual overlap is allowed, duplicate lettering is rejected',()=>{
 const r={snapshotId:'a',sceneId:'s',startCp:0,endCp:8},a={...r,endCp:4},b={...r,startCp:4};
 assert.equal(covers([r],[a,b],{exact:true}),true);assert.equal(covers([r],[r,r]),true);assert.equal(covers([r],[r,r],{exact:true}),false);assert.equal(covers([r],[a]),false);
 const p={panels:[{id:'p',sourceRefs:[a,b]}],layout:{pages:[{id:'page',slots:[{panelId:'p'}]}]}};assert.deepEqual(sourcePages(p)(a),[{panelId:'p',pageId:'page'}]);
});

test('JS and native share identical scalar fixtures and English never reuses Japanese offsets',async()=>{
 const {readFile}=await import('node:fs/promises');const fixture=JSON.parse(await readFile(new URL('./fixtures/source-refs.json',import.meta.url),'utf8'));
 const snapshots=[{id:'old',scenes:[{id:'s',text:fixture.text,sourceHash:fixture.sourceHash}]}];
 const {textForRefs}=await import('../src/source-refs.js');
 for(const item of fixture.cases){const ref={snapshotId:'old',sceneId:'s',startCp:item.startCp,endCp:item.endCp};assert.equal(resolveSourceRef(snapshots,ref),item.text);assert.throws(()=>textForRefs([ref],snapshots,[{locale:'en',snapshot_id:'old',units:[{id:'s:u0',text:'English'}]}]),/未更新/);}
});
