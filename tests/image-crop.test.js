import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultCrop,cropRect,panCrop,validateCrop} from '../src/image-crop.js';
import {ensureLayout,changeLayout,undoLayout,validateLayout,assertLegacyLiveLayout} from '../src/layout.js';
test('cover preserves aspect and fills portrait/landscape frames, pan clamps without gaps',()=>{
 for(const [w,h] of [[768,768],[1600,900],[900,1600]])for(const box of [{x:20,y:30,width:100,height:300},{x:20,y:30,width:300,height:100}]) {
  const crop={...defaultCrop(),zoom:2},r=cropRect(w,h,box,crop);
  assert.ok(r.width>=box.width&&r.height>=box.height);assert.ok(Math.abs(r.width/r.height-w/h)<1e-10);
  for(const d of [-10000,10000]){const next=panCrop(crop,r,box,d,d),m=cropRect(w,h,box,next);assert.ok(m.x<=box.x&&m.y<=box.y);assert.ok(m.x+m.width>=box.x+box.width-1e-8&&m.y+m.height>=box.y+box.height-1e-8);}
 }
});
test('crop history, reload and removal do not touch original artwork, lettering, source or jobs',()=>{
 const p=ensureLayout({panels:[{id:'p',image:'original',lettering:{mode:'balloons'},unitIds:['u']}],jobs:[]});
 const l={...p.layout,imageCrops:{p:defaultCrop()}},next=changeLayout(p,l);
 assert.equal(next.panels,p.panels);assert.equal(next.jobs,p.jobs);assert.deepEqual(ensureLayout(JSON.parse(JSON.stringify(next))).layout,l);
 assert.deepEqual(undoLayout(next).layout,p.layout);assert.deepEqual(undoLayout(undoLayout(next),true).layout,l);
 assert.throws(()=>assertLegacyLiveLayout(next),/トリミング/);assert.doesNotThrow(()=>assertLegacyLiveLayout(p));
 for(const crop of [null,{}, {zoom:NaN,x:0,y:0},{zoom:9,x:0,y:0},{zoom:1,x:-1,y:0},{zoom:1,x:0,y:Infinity}])assert.throws(()=>validateLayout({...l,imageCrops:{p:crop}},p.panels));
 assert.throws(()=>validateCrop({zoom:0,x:.5,y:.5}));
});
