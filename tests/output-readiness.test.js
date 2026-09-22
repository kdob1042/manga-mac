import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nameLetteringProblems} from '../src/name-v2.js';
import {outputProblems} from '../src/output.js';
const ref={snapshotId:'s',sceneId:'scene',startCp:0,endCp:4};
const ready=()=>({id:'p',namePlanVersion:2,image:'image',artwork_revision:'a',requiredText:[ref],letteringStatus:'ready',letteringArtworkRevision:'a',lettering:{mode:'balloons',boxes:[{id:'b',sourceRefs:[ref]}]}});

test('v2 publication requires exact ordered text coverage and lettering for the accepted art',()=>{
 const panel=ready();assert.deepEqual(nameLetteringProblems(panel),[]);
 for(const boxes of [[],[{sourceRefs:[ref,ref]}],[{sourceRefs:[{...ref,startCp:1}]}]])assert.match(nameLetteringProblems({...panel,lettering:{mode:'balloons',boxes}})[0].message,/欠落・重複・順序/);
 for(const patch of [{letteringStatus:'draft'},{letteringArtworkRevision:'old'},{lettering:{...panel.lettering,mode:'caption'}}])assert.match(nameLetteringProblems({...panel,...patch}).at(-1).message,/文字配置が未完了/);
 const split=[{sourceRefs:[{...ref,endCp:2}]},{sourceRefs:[{...ref,startCp:2}]}];
 assert.deepEqual(nameLetteringProblems({...panel,lettering:{mode:'balloons',boxes:split}}),[]);
 assert.match(nameLetteringProblems({...panel,lettering:{mode:'balloons',boxes:[{sourceRefs:[{}]}]}})[0].message,/掲載文字/);
 assert.deepEqual(nameLetteringProblems({...panel,requiredText:[],lettering:{mode:'balloons',boxes:[{id:'custom:p',text:'放課後'}]},letteringStatus:'draft',letteringArtworkRevision:null}),[]);
 assert.deepEqual(nameLetteringProblems({id:'hand-drawn',image:'image'}),[]);
});

test('deterministic export checks identify the existing repair stage without changing the project',()=>{
 const first=ready(),second={...ready(),id:'second',image:null},third={...ready(),id:'third',letteringArtworkRevision:'old'};
 const p={panels:[first,second,third],layout:{pages:[{id:'p0',slots:[{panelId:first.id}]},{id:'p1',slots:[{panelId:second.id},{panelId:third.id},{panelId:null}]}]}};
 const before=structuredClone(p),issues=outputProblems(p);
 assert.deepEqual(issues.map(({pageIndex,panelIndex,panelId,stage})=>({pageIndex,panelIndex,panelId,stage})),[
  {pageIndex:1,panelIndex:0,panelId:'second',stage:'art'},
  {pageIndex:1,panelIndex:1,panelId:'third',stage:'finish'},
  {pageIndex:1,panelIndex:2,panelId:null,stage:'layout'},
 ]);
 assert.deepEqual(p,before);
});
