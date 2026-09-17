import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {migrateProject} from '../src/revisions.js';
import {upscaleSize,requiredScale,beginUpscale,finishUpscale,adoptUpscale} from '../src/upscale.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/legacy-v1.json',import.meta.url)));
test('bounded interpolation dimensions and crop-aware required output pixels',async()=>{
 assert.deepEqual(upscaleSize(768,512,4),{width:3072,height:2048});
 for(const a of [[1025,1025,4],[768,768,3],[0,2,2],[NaN,768,2]])assert.throws(()=>upscaleSize(...a));
 const p=await migrateProject(fixture),id=p.panels[0].id;
 assert.ok(requiredScale(p,id,768,768)<1);
 p.layout.imageCrops={[id]:{zoom:2,x:.5,y:.5}};
 assert.equal(requiredScale(p,id,768,768),1030/768*2);
});
test('upscale candidates preserve placement, source and lettering; reject stale placement and support original image undo',async()=>{
 const p=await migrateProject(fixture),panel=p.panels[0],j=await beginUpscale(p,panel.id,768,768,2);
 const q=await finishUpscale({...p,jobs:[...p.jobs,j]},j,panel,panel.image);
 assert.deepEqual(q.panels,p.panels);assert.equal(q.jobs.at(-1).status,'candidate');assert.deepEqual(q.layout,p.layout);
 const stale=structuredClone(q);stale.layout.pages[0].slots[0].points[0][0]+=.001;
 await assert.rejects(adoptUpscale(stale,j.id),/配置/);
 const a=await adoptUpscale(q,j.id);assert.equal(a.panels[0].artwork_revision,`artwork:${j.id}`);assert.deepEqual(a.history.at(-1).panels,p.panels);assert.deepEqual(a.layout,p.layout);assert.deepEqual(a.snapshots,p.snapshots);assert.deepEqual(a.panels[0].lettering,panel.lettering);assert.equal(a.artworks.at(-1).parent_revision,panel.artwork_revision);
 await assert.rejects(adoptUpscale(a,j.id));
});
