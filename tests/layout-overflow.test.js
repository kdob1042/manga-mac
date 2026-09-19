import {test} from 'node:test';
import assert from 'node:assert/strict';
import {template,ensureLayout,validateLayout,layoutWarnings,changeLayout,undoLayout,artPoints,overflowDrawOrder,assertLegacyLiveLayout,PAGE} from '../src/layout.js';
import {layoutSchema} from '../src/layout-ai.js';
import {requiredScale} from '../src/upscale.js';
import {preparePreview} from '../src/live-preview.js';
import {createHash} from 'node:crypto';
const panels=Array.from({length:4},(_,i)=>({id:`p${i}`,unitIds:[`u${i}`],image:`image${i}`}));
const project=()=>ensureLayout({panels,active:'source',jobs:[]});
const pageOf=p=>p.layout.pages[0];
const expand=(points,dx=0.08)=>points.map(([x,y],i)=>[[Math.max(0,Math.min(1,x+(i===0||i===3?-dx:dx))),Math.max(0,Math.min(1,y+(i<2?-dx:dx)))]][0]);
test('overflow-less layouts keep previous warnings and templates omit overflow',()=>{
 const p=project();
 assert.deepEqual(layoutWarnings(p.layout,panels),[]);
 assert.equal(pageOf(p).slots.every(s=>s.overflow==null),true);
 assert.equal(template(4).every(s=>!s.overflow),true);
 assert.deepEqual(artPoints(pageOf(p).slots[0]),pageOf(p).slots[0].points);
});
test('overflow must be an on-page convex quad that contains the home frame',()=>{
 const p=project(),layout=structuredClone(p.layout),slot=layout.pages[0].slots[0];
 slot.overflow={points:structuredClone(slot.points)};
 assert.equal(validateLayout(layout,panels),layout);
 slot.overflow={points:[[1.1,0],[1,0],[1,1],[0,1]]};
 assert.throws(()=>validateLayout(layout,panels),/はみ出し領域はページ内/);
 slot.overflow={points:structuredClone(p.layout.pages[0].slots[1].points)};
 assert.throws(()=>validateLayout(layout,panels),/ホーム枠を含めて/);
 slot.overflow={points:structuredClone(p.layout.pages[0].slots[0].points),mask:true};
 assert.throws(()=>validateLayout(layout,panels),/未対応/);
 slot.overflow={points:structuredClone(p.layout.pages[0].slots[0].points),z:16};
 assert.throws(()=>validateLayout(layout,panels),/重ね順/);
});
test('overflow may overlap other home frames without the overlap warning',()=>{
 const p=project(),layout=structuredClone(p.layout),slot=layout.pages[0].slots[1];
 slot.overflow={points:expand(slot.points,0.03)};
 const warnings=layoutWarnings(layout,panels);
 assert.equal(warnings.some(w=>/枠.+重なって/.test(w)),false);
 assert.equal(warnings.some(w=>/はみ出し/.test(w)),false);
});
test('home-frame overlap stays a warning when overflow is also set',()=>{
 const p=project(),layout=structuredClone(p.layout);
 layout.pages[0].slots[1].points=structuredClone(layout.pages[0].slots[0].points);
 layout.pages[0].slots[0].overflow={points:structuredClone(layout.pages[0].slots[0].points)};
 assert.match(layoutWarnings(layout,panels).join(),/枠.+重なって/);
});
test('null overflow is treated as absent',()=>{
 const p=project(),layout=structuredClone(p.layout);
 layout.pages[0].slots[0].overflow=null;
 assert.equal(validateLayout(layout,panels),layout);
 assert.deepEqual(artPoints(layout.pages[0].slots[0]),layout.pages[0].slots[0].points);
});
test('overflow covering another panel lettering blocks finished export warnings',()=>{
 const p=project(),layout=structuredClone(p.layout);
 layout.pages[0].slots[0].overflow={points:[[0,0],[1,0],[1,1],[0,1]]};
 assert.match(layoutWarnings(layout,panels).join(),/はみ出しが他コマの文字/);
});
test('overflow draw order uses z then reading order',()=>{
 const slots=template(3,['a','b','c']);
 slots[0].overflow={points:structuredClone(slots[0].points),z:2};
 slots[2].overflow={points:structuredClone(slots[2].points),z:2};
 slots[1].overflow={points:structuredClone(slots[1].points),z:1};
 assert.deepEqual(overflowDrawOrder({slots}).map(x=>x.index),[1,0,2]);
});
test('layout history restores overflow and does not start generation',()=>{
 const p=project(),layout=structuredClone(p.layout);
 layout.pages[0].slots[0].overflow={points:expand(layout.pages[0].slots[0].points,0.02)};
 const changed=changeLayout(p,layout,'overflow',{pageIds:[layout.pages[0].id]});
 assert.ok(changed.layout.pages[0].slots[0].overflow);
 assert.equal(changed.jobs,p.jobs);
 assert.equal(changed.panels,p.panels);
 assert.equal(undoLayout(changed).layout.pages[0].slots[0].overflow,undefined);
 assert.ok(undoLayout(undoLayout(changed),true).layout.pages[0].slots[0].overflow);
});
test('legacy live layout rejects overflow even when home quads match the default grid',()=>{
 const p=project();
 p.layout.pages[0].slots[0].overflow={points:structuredClone(p.layout.pages[0].slots[0].points)};
 assert.throws(()=>assertLegacyLiveLayout(p),/自由コマ割り/);
});
test('AI layout schema allows omitting overflow',()=>{
 const slot=layoutSchema.properties.pages.items.properties.slots.items;
 assert.equal(slot.required.includes('overflow'),false);
 assert.equal(slot.properties.overflow.required.includes('points'),true);
});
test('requiredScale uses overflow bounds when present',()=>{
 const p=project();
 const base=requiredScale(p,'p0',768,768);
 p.layout.pages[0].slots[0].overflow={points:[[0,0],[1,0],[1,1],[0,1]]};
 assert.ok(requiredScale(p,'p0',768,768)>base);
});
test('live preview clip stays on the home frame when overflow is set',async()=>{
 const sha=x=>createHash('sha256').update(x).digest('hex');
 const p=project();
 p.workId='work';p.revision=1;p.title='overflow';p.snapshots=[{id:'s',repo:'t/s',episodeId:'ep',scenes:[{id:'a',text:'原稿',tags:[]}]}];
 p.panels=p.panels.map((panel,i)=>({...panel,sourceRefs:[],image:i?'art':null,snapshotId:'s',sceneId:'a'}));
 p.layout.pages[0].slots[0].overflow={points:[[0,0],[1,0],[1,1],[0,1]]};
 const home=p.layout.pages[0].slots[0].points.map(([x,y])=>[x*PAGE.width,y*PAGE.height]);
 const {preview}=await preparePreview({project:p,revision:'r',savedAt:'2026-09-19T00:00:00.000Z'},{
  image:async data=>{const id=sha(data),page=data.startsWith('layer');return {id,sha256:id,path:`assets/${id}.png`,mime:'image/png',bytes:Buffer.byteLength(data),width:page?1600:720,height:page?2260:720};},
  placeholder:async()=>'placeholder',layers:async(_panels,_project,layer)=>'layer:'+layer,probeVideo:async()=>{throw Error('pending');},
 });
 assert.deepEqual(preview.manifest.pages[0].panels[0].clip,home);
});
