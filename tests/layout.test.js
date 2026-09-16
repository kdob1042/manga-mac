import {test} from 'node:test';
import assert from 'node:assert/strict';
import {template,initialLayout,ensureLayout,validateLayout,validQuad,layoutWarnings,changeLayout,undoLayout,contentBox,inside} from '../src/layout.js';
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
 assert.deepEqual(layoutWarnings(l,panels),[]);const changed=changeLayout(p,l);assert.equal(changed.panels,p.panels);assert.equal(changed.jobs,p.jobs);
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
test('overlaps, missing/duplicate references and reordered content cannot silently export',()=>{
 const p=project(),l=structuredClone(p.layout);l.pages[0].slots[1].points=l.pages[0].slots[0].points;assert.match(layoutWarnings(l,panels).join(),/重な/);
 l.pages[0].slots[1].panelId='p0';assert.throws(()=>validateLayout(l,panels));
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
test('Live Manga v1 refuses reshaped and six-panel layouts before media export',async()=>{
 const {assertLegacyLiveLayout}=await import('../src/layout.js');const p=project();assert.doesNotThrow(()=>assertLegacyLiveLayout(p));
 p.layout.pages[0].slots[0].points[0][0]+=.01;assert.throws(()=>assertLegacyLiveLayout(p),/Live Manga v1/);
 const six=ensureLayout({panels:panels.slice(0,6)});six.layout.pages=[{id:'six',slots:template(6,panels.slice(0,6).map(p=>p.id))}];assert.throws(()=>assertLegacyLiveLayout(six),/Live Manga v1/);
});
