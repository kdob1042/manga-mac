import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {rasterBundle,beginCompositor,finishCompositor,reconcileBindings,operation,compositorRevision} from '../src/compositor.js';
import {migrateProject,adoptCandidate} from '../src/revisions.js';
globalThis.crypto ??= webcrypto;
const fixture=JSON.parse(readFileSync(new URL('fixtures/legacy-v1.json',import.meta.url)));

test('Compositor candidates preserve editable source and use existing adoption/undo history',async()=>{
 const project=await migrateProject(fixture), panel=project.panels.find(p=>p.image), job=await beginCompositor(project,panel);
 const bundle=rasterBundle(panel.image,32,32), state={document:bundle.manifest.documentID,revision:4,owner:'app',layers:bundle.manifest.layers};
 const result={bundle,state,image:panel.image,upstream_revision:compositorRevision,includes_unsaved_changes:true};
 const ready={...project,jobs:[...project.jobs,job]}, completed=await finishCompositor(ready,job,result);
 assert.equal(completed.jobs.at(-1).status,'candidate');assert.deepEqual(completed.panels,project.panels);
 const adopted=await adoptCandidate(completed,job.id);
 assert.deepEqual(adopted.panels.find(p=>p.id===panel.id).compositor.bundle,bundle);
 assert.deepEqual(adopted.history.at(-1).panels,project.panels);
 assert.deepEqual((await migrateProject(adopted,true)).panels,adopted.panels);
 assert.equal(JSON.stringify(adopted.panels).includes('token'),false);
 const changed={...ready,panels:ready.panels.map(p=>p.id===panel.id?{...p,prompt:'changed'}:p)};
 const late=await finishCompositor(changed,job,result);
 await assert.rejects(()=>adoptCandidate(late,job.id),/基準版/);
 await assert.rejects(()=>finishCompositor(ready,job,{...result,state:{...state,document:'wrong'}}),/一致/);
});

test('layer character bindings never infer from names or array order',()=>{
 assert.deepEqual(reconcileBindings({a:'p1',b:'p2',c:'missing'},{layers:[{id:'b',name:'p1'},{id:'c'}]},[{id:'p1'},{id:'p2'}]),{b:'p2'});
 assert.throws(()=>operation({document:'x',revision:NaN,owner:'app'},'transform'),/再取得/);
 assert.deepEqual(operation({document:'x',revision:3,owner:'app'},'transform',{layer:'a',x:2}),{op:'transform',document:'x',revision:3,layer:'a',x:2});
});
