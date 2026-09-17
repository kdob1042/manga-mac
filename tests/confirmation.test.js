import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureLayout,template,reflowLayout,changeLayout} from '../src/layout.js';
import {confirmThroughPage,confirmedPageIndex,moveConfirmationBeforePage} from '../src/confirmation.js';
import {validateProposal} from '../src/layout-ai.js';
const panels=Array.from({length:12},(_,i)=>({id:`p${i}`,unitIds:[`u${i}`],prompt:`p${i}`,characterIds:[]}));
const make=()=>ensureLayout({panels,active:'source',jobs:[]});
test('confirmation is one contiguous prefix and can move backward explicitly',()=>{
 let p=confirmThroughPage(make(),1);assert.equal(p.confirmedThroughPanelId,'p7');assert.equal(confirmedPageIndex(p),1);
 p=confirmThroughPage(p,2);assert.equal(confirmedPageIndex(p),2);
 p=moveConfirmationBeforePage(p,1);assert.equal(confirmedPageIndex(p),0);
 p=moveConfirmationBeforePage(p,0);assert.equal(confirmedPageIndex(p),-1);
});
test('confirmed prefix rejects local edits and reflow until boundary is moved back',()=>{
 const p=confirmThroughPage(make(),0),local=structuredClone(p.layout);local.pages[0].slots[0].points[0][0]+=.01;
 assert.throws(()=>changeLayout(p,local),/確定済み/);
 const pagination=structuredClone(p.layout);pagination.pages[0].slots=template(3,['p0','p1','p2']);
 assert.throws(()=>reflowLayout(p,pagination,0),/確定済み/);
 const suffix=structuredClone(p.layout);suffix.pages[1].slots=template(3,['p4','p5','p6']);
 assert.doesNotThrow(()=>reflowLayout(p,suffix,1));
});
test('AI suffix proposal may repaginate after boundary but cannot change confirmed prefix',()=>{
 const p=confirmThroughPage(make(),0),scope=p.layout.pages.slice(1).map(x=>x.id),prefix=structuredClone(p.layout.pages[0]);
 const proposal=[{id:'new-a',slots:template(5,['p4','p5','p6','p7','p8'])},{id:'new-b',slots:template(3,['p9','p10','p11'])}];
 const candidate=validateProposal(p,{reason:'残りを再構成',pages:proposal},scope);
 assert.deepEqual(candidate.layout.pages[0],prefix);assert.equal(candidate.layout.pages.length,3);assert.equal(candidate.suffixPagination,true);
 assert.throws(()=>validateProposal(p,{reason:'確定範囲',pages:[prefix]},[prefix.id]),/確定済み/);
});
test('confirmation survives JSON save/reload as a stable panel boundary',()=>{
 const p=confirmThroughPage(make(),1),saved=JSON.parse(JSON.stringify(p)),loaded=ensureLayout(saved);
 assert.equal(loaded.confirmedThroughPanelId,p.confirmedThroughPanelId);assert.equal(confirmedPageIndex(loaded),1);
});
