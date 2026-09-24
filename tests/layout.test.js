import {test} from 'node:test';
import assert from 'node:assert/strict';
import {template,initialLayout,ensureLayout,validateLayout,validQuad,resizeQuadEdge,dragSlotFrame,bounds,layoutWarnings,reflowLayout,changeLayout,undoLayout,contentBox,inside} from '../src/layout.js';
import {validateProposal,adoptLayoutProposal} from '../src/layout-ai.js';
const panels=Array.from({length:10},(_,i)=>({id:`p${i}`,unitIds:[`u${i}`],image:`image${i}`}));
const project=()=>ensureLayout({panels,active:'source',jobs:[]});
test('old four-panel geometry, partial page and stable migration',()=>{
 const p=project();assert.deepEqual(p.layout.pages.map(p=>p.slots.length),[4,4,2]);
 const s=p.layout.pages[0].slots[0];assert.deepEqual(contentBox(s.points),{x:820,y:60,width:720,height:1030});
 assert.deepEqual(ensureLayout(p),p);
});
test('mixed four/six pages and 1/3/5/8 slots retain source, no generation',()=>{
 const p=project(),l=structuredClone(p.layout);l.pages=[{id:'a',slots:template(4,panels.slice(0,4).map(p=>p.id))},{id:'b',slots:template(6,panels.slice(4).map(p=>p.id))}];
 assert.deepEqual(layoutWarnings(l,panels),[]);const changed=changeLayout(p,l,'test',{pageIds:p.layout.pages.map(p=>p.id),allowPageChanges:true});assert.equal(changed.panels,p.panels);assert.equal(changed.jobs,p.jobs);
 assert.deepEqual(undoLayout(changed).layout,p.layout);assert.deepEqual(undoLayout(undoLayout(changed),true).layout,l);
 for(const n of [1,3,5,8,16])assert.ok(template(n).every(s=>validQuad(s.points)));
});
test('quad validation refuses bowties, inverted order, duplicates, NaN, out-of-page and slivers',()=>{
 const good=[[.1,.1],[.9,.2],[.8,.9],[.2,.8]];assert.ok(validQuad(good));
 for(const points of [[good[0],good[2],good[1],good[3]],[...good].reverse(),[good[0],good[0],good[2],good[3]],[[NaN,.1],...good.slice(1)],[[1.1,.1],...good.slice(1)],[[0,0],[.001,0],[.001,.001],[0,.001]]])assert.equal(validQuad(points),false);
 const box=contentBox(good);assert.ok(inside([box.x/1600,box.y/2260],good));
});
test('unassignment retained across reload; new content gets new pages without resetting edited frames',()=>{
 const p=project();p.layout.pages[0].slots[0].panelId=null;p.layout.pages[0].slots[1].points[0][0]+=.01;
 const reloaded=ensureLayout(JSON.parse(JSON.stringify(p)));assert.deepEqual(reloaded.layout,p.layout);assert.match(layoutWarnings(p.layout,panels).join(),/未割当/);
 const extended=ensureLayout({...p,panels:[...panels,{id:'new'}]});assert.deepEqual(extended.layout.pages.slice(0,3),p.layout.pages);assert.equal(extended.layout.pages[3].slots[0].panelId,'new');
});
test('superseded per-page locks are removed on load',()=>{
 const p=project(),legacy=structuredClone(p);legacy.layout.pages[1].locked=true;
 const migrated=ensureLayout(legacy);assert.equal('locked' in migrated.layout.pages[1],false);assert.deepEqual(migrated.layout.pages[1].slots,p.layout.pages[1].slots);
});
test('overlaps, missing/duplicate references and reordered content cannot silently export',()=>{
 const p=project(),l=structuredClone(p.layout);l.pages[0].slots[1].points=l.pages[0].slots[0].points;assert.match(layoutWarnings(l,panels).join(),/重な/);
 l.pages[0].slots[1].panelId='p0';assert.throws(()=>validateLayout(l,panels));
});
test('local geometry edit does not reflow or alter any page assignment',()=>{
 const p=project(),l=structuredClone(p.layout),assignments=p.layout.pages.map(pg=>pg.slots.map(s=>s.panelId));
 l.pages[1].slots[0].points[0][0]+=.01;const changed=changeLayout(p,l,'test',{pageIds:p.layout.pages.map(p=>p.id),allowPageChanges:true});
 assert.deepEqual(changed.layout.pages.map(pg=>pg.slots.map(s=>s.panelId)),assignments);
 assert.deepEqual(changed.layout.pages[0],p.layout.pages[0]);assert.notDeepEqual(changed.layout.pages[1].slots[0].points,p.layout.pages[1].slots[0].points);
});
test('dragging an edge resizes only its two corners and keeps undoable layout history',()=>{
 const p=project(),slot=p.layout.pages[0].slots[0],moved=resizeQuadEdge(slot.points,1,[-.01,.02]);
 assert.deepEqual(moved[0],slot.points[0]);assert.deepEqual(moved[3],slot.points[3]);
 assert.ok(moved[1][0]<slot.points[1][0]);assert.equal(moved[1][1],slot.points[1][1]);
 assert.equal(moved[1][0],moved[2][0]);
 assert.ok(validQuad(moved));assert.ok(validQuad(slot.points));
 const layout=structuredClone(p.layout);layout.pages[0].slots[0].points=moved;
 const changed=changeLayout(p,layout,'枠サイズ調整',{pageIds:[layout.pages[0].id]});
 assert.deepEqual(changed.layout.pages.slice(1),p.layout.pages.slice(1));assert.equal(changed.panels,p.panels);
 assert.deepEqual(undoLayout(changed).layout,p.layout);
});
test('slanted edge resize preserves adjacent margin lines instead of translating the corners',()=>{
 const points=[[.1,0],[.7,0],[.9,1],[.1,1]],next=resizeQuadEdge(points,1,[-.12,.05]);
 assert.deepEqual(next[0],points[0]);assert.deepEqual(next[3],points[3]);
 assert.equal(next[1][1],0);assert.equal(next[2][1],1);
 assert.ok(Math.abs(next[2][0]-next[1][0]-.2)<1e-10);assert.ok(validQuad(next));
});
test('frame snapping uses screen distance, neighbouring margins and can be released',()=>{
 const slot={id:'a',points:[[.1,.1],[.5,.1],[.5,.5],[.1,.5]]};
 const page={slots:[slot,{id:'b',points:[[.1,.6],[.8,.6],[.8,.9],[.1,.9]]}]};
 for(const width of [400,800,1200]){
  const options={page,width,height:width*2260/1600},delta=[.3-4/width,0];
  const {slot:next,guides}=dragSlotFrame(slot,{edge:1},delta,options);
  assert.ok(Math.abs(next.points[1][0]-.8)<1e-9);assert.ok(guides.some(g=>g.axis===0&&g.value===.8));
  assert.equal(next.points[1][1],.1);assert.deepEqual(next.points[0],slot.points[0]);
  const free=dragSlotFrame(slot,{edge:1},delta,{...options,snap:false}).slot;
  assert.ok(Math.abs(free.points[1][0]-(.8-4/width))<1e-9);
 }
 assert.equal(slot.points[1][0],.5);
});
test('extreme frame drags clamp at the page or minimum size and keep overflow with an explicit move',()=>{
 const slot={id:'a',points:[[.1,.1],[.5,.1],[.5,.5],[.1,.5]]},options={page:{slots:[slot]},width:800,height:1130};
 const expanded=dragSlotFrame(slot,{edge:1},[10,0],options).slot;
 assert.equal(expanded.points[1][0],1);assert.ok(validQuad(expanded.points));
 const tiny=dragSlotFrame(slot,{edge:1},[-10,0],options).slot;
 assert.ok(validQuad(tiny.points));assert.ok(bounds(tiny.points).width*800>=23.99);
 assert.deepEqual(tiny.points[0],slot.points[0]);
 const corner=dragSlotFrame(slot,{vertex:0},[10,10],options).slot;
 assert.ok(validQuad(corner.points));assert.notDeepEqual(corner.points,slot.points);
 const overflow={points:[[0,0],[.7,0],[.7,.7],[0,.7]],z:2};
 const moved=dragSlotFrame({...slot,overflow},{},[.1,.1],options).slot;
 assert.deepEqual(moved.overflow.points,overflow.points.map(p=>p.map(v=>v+.1)));
 assert.ok(moved.points.every(p=>inside(p,moved.overflow.points)));
 const limited=dragSlotFrame({...slot,overflow},{edge:1},[10,0],options).slot;
 assert.ok(limited.points.every(p=>inside(p,overflow.points)));assert.deepEqual(limited.overflow,overflow);
});
test('reflow pulls and pushes panels across every following page without touching artwork or source order',()=>{
 const p=project(),beforePanels=p.panels,beforeJobs=p.jobs;
 const wider=structuredClone(p.layout);wider.pages[0].slots=template(5,wider.pages[0].slots.map(s=>s.panelId));
 const pulled=reflowLayout(p,wider,0);
 assert.deepEqual(pulled.pages.map(pg=>pg.slots.map(s=>s.panelId)),[['p0','p1','p2','p3','p4'],['p5','p6','p7','p8'],['p9']]);
 assert.deepEqual(layoutWarnings(pulled,panels),[]);
 const narrow=structuredClone(p.layout);narrow.pages[0].slots=template(3,narrow.pages[0].slots.slice(0,3).map(s=>s.panelId));
 const pushed=reflowLayout(p,narrow,0);
 assert.deepEqual(pushed.pages.map(pg=>pg.slots.map(s=>s.panelId)),[['p0','p1','p2'],['p3','p4','p5','p6'],['p7','p8'],['p9']]);
 assert.deepEqual(layoutWarnings(pushed,panels),[]);assert.equal(p.panels,beforePanels);assert.equal(p.jobs,beforeJobs);
});
test('reflow keeps pages before start byte-identical and continues through the suffix',()=>{
 const p=project(),l=structuredClone(p.layout),first=structuredClone(l.pages[0]);
 l.pages[1].slots=template(3,['p4','p5','p6']);
 const flowed=reflowLayout(p,l,1);assert.deepEqual(flowed.pages[0],first);
 assert.deepEqual(flowed.pages.map(pg=>pg.slots.map(s=>s.panelId)),[['p0','p1','p2','p3'],['p4','p5','p6'],['p7','p8'],['p9']]);
 assert.deepEqual(layoutWarnings(flowed,panels),[]);
});
test('changeLayout reflows only with an explicit start range',()=>{
 const p=project(),l=structuredClone(p.layout);l.pages[1].slots=template(3,l.pages[1].slots.slice(0,3).map(s=>s.panelId));
 const changed=changeLayout(p,l,'test',{pageIds:[p.layout.pages[1].id],reflowFrom:1});assert.deepEqual(changed.layout.pages[0],p.layout.pages[0]);
 assert.deepEqual(changed.layout.pages.map(pg=>pg.slots.map(s=>s.panelId)),[['p0','p1','p2','p3'],['p4','p5','p6'],['p7','p8'],['p9']]);
});
test('AI candidate protects other pages, stale base and source order; rejects invalid shape',()=>{
 const p=project(),page=structuredClone(p.layout.pages[0]);page.slots[0].points[0][0]+=.03;
 const c=validateProposal(p,{reason:'最初の境界を斜めに',pages:[page]},[page.id]);const adopted=adoptLayoutProposal(p,c);
 assert.deepEqual(adopted.layout.pages.slice(1),p.layout.pages.slice(1));assert.equal(adopted.panels,p.panels);
 assert.throws(()=>adoptLayoutProposal({...p,active:'new'},c),/変更/);
 page.slots.reverse();assert.throws(()=>validateProposal(p,{reason:'bad',pages:[page]},[page.id]),/読書順/);
});
test('whole-work AI can paginate four plus six without losing any source IDs',()=>{
 const p=project(); const pages=[{id:'new-a',slots:template(4,panels.slice(0,4).map(p=>p.id))},{id:'new-b',slots:template(6,panels.slice(4).map(p=>p.id))}];
 const c=validateProposal(p,{reason:'会話は6コマ、導入は4コマ',pages},p.layout.pages.map(p=>p.id));assert.deepEqual(c.layout.pages.map(p=>p.slots.length),[4,6]);
 pages[1].slots.pop();assert.throws(()=>validateProposal(p,{reason:'欠落',pages},p.layout.pages.map(p=>p.id)),/読書順/);
});
test('optional overflow is validated and omitted from templates',()=>{
 const p=project();
 assert.equal(template(4).every(s=>!s.overflow),true);
 const l=structuredClone(p.layout);
 l.pages[0].slots[0].overflow={points:structuredClone(l.pages[0].slots[0].points)};
 assert.equal(validateLayout(l,panels),l);
 l.pages[0].slots[0].overflow={points:[[-0.1,0],[1,0],[1,1],[0,1]]};
 assert.throws(()=>validateLayout(l,panels),/はみ出し領域はページ内/);
});
test('publication placement covers the frame by default and shares free-layout crop transforms',async()=>{
 const {frameRect,panelArtRect,livePanelGeometry}=await import('../src/page-art.js');
 const {defaultCrop,containCrop}=await import('../src/image-crop.js');
 const slots=template(4,panels.slice(0,4).map(p=>p.id));
 const f0=frameRect(slots[0].points),base=panelArtRect(slots[0].points,512,512);
 assert.deepEqual(base,panelArtRect(slots[0].points,512,512,defaultCrop()));
 assert.ok(base.x<=f0.x&&base.y<=f0.y&&base.x+base.width>=f0.x+f0.width&&base.y+base.height>=f0.y+f0.height);
 assert.equal(base.width/base.height,1);
 assert.deepEqual(panelArtRect(slots[0].points,512,512,containCrop()),{x:822,y:62,width:716,height:716});
 const live=livePanelGeometry(slots[0],512,512);
 assert.deepEqual(live.frame,f0);
 assert.deepEqual(live.clip,slots[0].points.map(([x,y])=>[x*1600,y*2260]));
 assert.deepEqual(live.artRect,base);
 const contained=livePanelGeometry(slots[0],512,512,containCrop());
 assert.deepEqual(contained.artRect,{x:822,y:62,width:716,height:716});
 slots[0].points[0][0]+=.04;
 const f=frameRect(slots[0].points),r=panelArtRect(slots[0].points,512,512,{zoom:2,x:.75,y:.25});
 assert.ok(r.x<f.x&&r.y<f.y&&r.x+r.width>=f.x+f.width&&r.y+r.height>=f.y+f.height);
 assert.equal(r.width/r.height,1);
});
