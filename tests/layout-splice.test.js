import {test} from 'node:test';import assert from 'node:assert/strict';
import {ensureLayout,template,layoutSplice,validateLayoutPatch,applyLayoutSplices,undoLayout,reflowLayoutInterval,layoutWarnings} from '../src/layout.js';
import {validateProposal,adoptLayoutProposal} from '../src/layout-ai.js';
const fixture=()=>ensureLayout({active:'s',panels:Array.from({length:20},(_,i)=>({id:`p${i}`,image:`image${i}`,unitIds:[`u${i}`],sourceRefs:[{snapshotId:i%2?'old':'new',sceneId:'s',startCp:i,endCp:i+1}],lettering:{mode:'caption',boxes:[]}})),jobs:[],sourceApplication:{version:1,units:[{id:'keep'}]},panelMotions:[{panelId:'p19',videoRevision:'v'}]});
const pages=(ids,counts)=>{let at=0;return counts.map((n,i)=>({id:`new${i}`,slots:template(n,ids.slice(at,at+=n))}));};
test('middle two pages become three and both surrounding regions remain byte-identical',()=>{
 const p=fixture(),before=structuredClone(p),replacement=pages(p.panels.slice(4,12).map(p=>p.id),[3,3,2]),s=layoutSplice(p,1,2,replacement),next=applyLayoutSplices(p,[s]);
 assert.deepEqual(p,before);assert.deepEqual(next.layout.pages[0],p.layout.pages[0]);assert.deepEqual(next.layout.pages.slice(4),p.layout.pages.slice(3));assert.equal(next.panels,p.panels);assert.equal(next.sourceApplication,p.sourceApplication);assert.equal(next.panelMotions,p.panelMotions);assert.equal(next.jobs,p.jobs);assert.deepEqual(layoutWarnings(next.layout,p.panels),[]);
 assert.deepEqual(undoLayout(next).layout,p.layout);assert.deepEqual(undoLayout(undoLayout(next),true).layout,next.layout);assert.deepEqual(ensureLayout(JSON.parse(JSON.stringify(next))).layout,next.layout);
 assert.throws(()=>applyLayoutSplices(next,[s]),/基準版/);
 const candidate=validateProposal(p,{reason:'中間だけ',pages:replacement},p.layout.pages.slice(1,3).map(p=>p.id),'op');assert.deepEqual(adoptLayoutProposal(p,candidate).layout.pages.slice(-2),p.layout.pages.slice(-2));
});
test('independent splices use the same old indices and preserve intervening pages',()=>{
 const p=fixture(),a=layoutSplice(p,0,1,pages(['p0','p1','p2','p3'],[2,2])),b=layoutSplice(p,3,1,[{id:'far',slots:template(4,['p12','p13','p14','p15'])}]);
 const l=validateLayoutPatch(p,p.panels,[b,a]);assert.deepEqual(l.pages.slice(2,4),p.layout.pages.slice(1,3));assert.equal(l.pages.at(-1).id,p.layout.pages.at(-1).id);assert.throws(()=>validateLayoutPatch(p,p.panels,[a,a]),/重複/);
});
test('insertion at head, middle, tail and full deletion are explicit, retained content cannot vanish',()=>{
 const p=fixture();for(const at of [0,2,5]){const s=layoutSplice(p,at,0,[{id:'blank',slots:template(1)}]);assert.equal(validateLayoutPatch(p,p.panels,[s]).pages[at].id,'blank');}
 const all=layoutSplice(p,0,5,[]);assert.throws(()=>validateLayoutPatch(p,p.panels,[all]),e=>e.code==='LAYOUT_SCOPE_EXPANSION_REQUIRED');assert.throws(()=>validateLayoutPatch(p,[],[all]),/動画/);assert.deepEqual(validateLayoutPatch({...p,panelMotions:[]},[],[all]).pages,[]);
 const bad=layoutSplice(p,2,0,[]);bad.beforePageId='missing';assert.throws(()=>validateLayoutPatch(p,p.panels,[bad]),/境界/);
 p.panels[0].manual=true;assert.throws(()=>validateLayoutPatch(p,[],[layoutSplice(p,0,5,[])]),/手動/);
});
test('six panels minus two can locally retain four; outside content and invalid geometry are rejected',()=>{
 const p=fixture();p.layout.pages=[...p.layout.pages.slice(0,1),{id:'six',slots:template(6,p.panels.slice(4,10).map(p=>p.id))},...pages(p.panels.slice(10).map(p=>p.id),[5,5])];
 const keep=p.panels.filter(p=>!['p5','p8'].includes(p.id)),s=layoutSplice(p,1,1,[{id:'four',slots:template(4,['p4','p6','p7','p9'])}]);const l=validateLayoutPatch(p,keep,[s]);assert.deepEqual(l.pages.slice(2),p.layout.pages.slice(2));
 const changed=structuredClone(keep);changed[0].image='changed';assert.throws(()=>validateLayoutPatch(p,changed,[s]),/対象外/);
 s.replacementPages[0].slots[0].points[0]=[2,2];assert.throws(()=>validateLayoutPatch(p,keep,[s]),/凸四角形/);
});
test('local template IDs are deterministic per op and never consume following content',()=>{
 const p=fixture(),s=reflowLayoutInterval(p,1,1,3,'op');assert.deepEqual(s,reflowLayoutInterval(p,1,1,3,'op'));const next=applyLayoutSplices(p,[s]);assert.equal(next.layout.pages.length,6);assert.deepEqual(next.layout.pages.slice(3),p.layout.pages.slice(2));assert.deepEqual(next.layout.pages.slice(1,3).flatMap(p=>p.slots.map(s=>s.panelId).filter(Boolean)),['p4','p5','p6','p7']);
});
