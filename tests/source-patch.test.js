import {test} from 'node:test';import assert from 'node:assert/strict';
import {undoEdit} from '../src/edit-commands.js';
import {buildChangeSet} from '../src/source-diff.js';
import {prepareSourceUpdate,commitSourceUpdate} from '../src/source-patch.js';
test('source Undo/Redo restores manga and application without rewinding active source, jobs or receipts',()=>{
 const before={panels:[],layout:{version:1,pages:[]},sourceApplication:{version:1,units:[]}},after={...structuredClone(before),panels:[{id:'new'}],sourceApplication:{version:1,units:[{id:'u'}]}},entry={...before,after,edit:true,sourcePatch:true,opId:'op'};
 const project={...after,history:[entry],editRedo:[],active:'latest',jobs:[{cost:17,status:'complete'}],sourcePatchReceipts:{op:{}}};
 const undo=undoEdit(project);assert.deepEqual(undo.panels,[]);assert.deepEqual(undo.sourceApplication,before.sourceApplication);assert.equal(undo.active,'latest');assert.deepEqual(undo.jobs,project.jobs);assert.deepEqual(undo.sourcePatchReceipts,project.sourcePatchReceipts);assert.deepEqual(undoEdit(undo,true),project);
 assert.throws(()=>undoEdit({...project,panels:[{id:'another-edit'}]}),/別の編集/);
});
test('preparation validates selection before invoking and durable receipts permit retry after Undo',async()=>{
 const p={version:5,workId:'w',contentToken:'base',active:'s',snapshots:[{id:'s',scenes:[{id:'scene',text:'A'}]}],sourceApplication:{version:1,units:[]},panels:[],layout:{version:1,pages:[]}};
 const changes=buildChangeSet(p),selection={changeSetId:changes.id,baseContentToken:'base',targetSnapshotId:'s',selectedBlockIds:changes.blocks.map(b=>b.id)},calls=[];
 const invoke=async(command,args)=>{calls.push({command,args});return {saved:true};};
 await assert.rejects(()=>prepareSourceUpdate(p,{...selection,baseContentToken:'old'},invoke),/選び直/);assert.equal(calls.length,0);
 const prepared=await prepareSourceUpdate(p,selection,invoke,'op');assert.equal(calls[0].command,'prepare_source_patch');assert.equal(calls[0].args.expected.afterUnits.length,1);
 await commitSourceUpdate({...p,contentToken:'after-undo',sourcePatchReceipts:{op:{}}},prepared,{},invoke);assert.equal(calls[1].command,'commit_source_patch');
 await assert.rejects(()=>commitSourceUpdate({...p,workId:'other'},prepared,{},invoke),/作品/);
});
