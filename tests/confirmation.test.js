import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureLayout,template,reflowLayout,changeLayout,undoLayout} from '../src/layout.js';
import {validateProposal,adoptLayoutProposal,proposeLayout} from '../src/layout-ai.js';
const panels=Array.from({length:12},(_,i)=>({id:`p${i}`,unitIds:[`u${i}`],prompt:`p${i}`,characterIds:[]}));
const make=()=>ensureLayout({panels,active:'source',jobs:[],snapshots:[]});
test('legacy confirmation disappears from current and history without changing layout',()=>{
 const p=make(),legacy={...p,confirmedThroughPanelId:'p7',history:[{panels,confirmedThroughPanelId:'p3',after:{confirmedThroughPanelId:'p7'}}]};
 const migrated=ensureLayout(legacy);assert.equal(migrated.confirmedThroughPanelId,undefined);assert.deepEqual(migrated.layout,p.layout);
 assert.equal(migrated.history[0].confirmedThroughPanelId,undefined);assert.equal(migrated.history[0].after.confirmedThroughPanelId,undefined);
 assert.equal(ensureLayout(JSON.parse(JSON.stringify(migrated))).confirmedThroughPanelId,undefined);
});
test('formerly confirmed page accepts scoped edits; other pages and crop cannot change',()=>{
 const p=ensureLayout({...make(),confirmedThroughPanelId:'p7'}),local=structuredClone(p.layout);local.pages[0].slots[0].points[0][0]+=.01;
 const scope={pageIds:[p.layout.pages[0].id]};const next=changeLayout(p,local,'edit',scope);
 assert.deepEqual(next.layout.pages.slice(1),p.layout.pages.slice(1));assert.deepEqual(undoLayout(next).layout,p.layout);
 local.pages[1].slots[0].points[0][0]+=.01;assert.throws(()=>changeLayout(p,local,'edit',scope),/対象外/);
 assert.throws(()=>changeLayout(p,{...p.layout,imageCrops:{p8:{zoom:2,x:.5,y:.5}}},'crop',scope),/対象外/);
 assert.throws(()=>changeLayout(p,p.layout),/明示/);
});
test('reflow rejects a changed prefix; scoped AI adoption revalidates persisted candidate',()=>{
 const p=make(),l=structuredClone(p.layout);l.pages[0].slots[0].points[0][0]+=.01;
 assert.throws(()=>reflowLayout(p,l,1),/指定範囲/);
 const scope=p.layout.pages.slice(1).map(x=>x.id),proposal=[{id:'new-a',slots:template(5,['p4','p5','p6','p7','p8'])},{id:'new-b',slots:template(3,['p9','p10','p11'])}];
 const c=validateProposal(p,{reason:'選択範囲',pages:proposal},scope);assert.deepEqual(adoptLayoutProposal(p,c).layout.pages[0],p.layout.pages[0]);
 c.layout.pages[0].slots[0].points[0][0]+=.01;assert.throws(()=>adoptLayoutProposal(p,c),/対象外/);
 assert.throws(()=>validateProposal(p,{reason:'bad',pages:[]},[p.layout.pages[0].id,p.layout.pages[2].id]),/対象ページ/);
});
test('whole-work AI uses exactly the explicit scope and no legacy boundary',async()=>{
 const p=ensureLayout({...make(),confirmedThroughPanelId:'p7'});let input;
 await proposeLayout(p,p.layout.pages.map(pg=>pg.id),'全体',async prompt=>{input=JSON.parse(prompt);return JSON.stringify({reason:'全体',pages:input.pages});});
 assert.equal(input.pages.length,3);assert.equal(input.wholeWork,true);
});
