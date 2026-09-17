import test from 'node:test';
import assert from 'node:assert/strict';
import {recognizeRegions,letteringRegions,checkVisualEdit,regionForEdit,validRegion} from '../src/visual-regions.js';
import {emptyProject} from '../src/core.js';
import {ensureLayout} from '../src/layout.js';
const fixture=()=>ensureLayout({...emptyProject(),panels:[{id:'p',characterIds:[],image:'original'}]});
test('recognition requires supplied image, exact target and nonambiguous bounded rectangles',async()=>{
 const p=fixture(),result={uncertain:false,reason:'visible',regions:[{panelId:'p',purpose:'edit',label:'服',rect:[.2,.3,.3,.4]}]};
 const visual=await recognizeRegions(p,['p'],'服を直す',async(prompt,schema,images)=>{assert.deepEqual(images,['original']);return JSON.stringify(result);},async()=>({width:800,height:400}));
 assert.deepEqual(regionForEdit({visual},'p'),[.2,.3,.3,.4]);
 assert.equal(validRegion([.8,.2,.4,.2]),false);
 await assert.rejects(()=>recognizeRegions(p,['p'],'服',async()=>JSON.stringify({...result,uncertain:true}),async()=>assert.fail()),/特定できません/);
 await assert.rejects(()=>recognizeRegions(p,['p'],'服',async()=>JSON.stringify({...result,regions:[{...result.regions[0],panelId:'other'}]}),async()=>assert.fail()),/不正/);
});
test('lettering regions use actual contain/crop placement; overlap and clipped subjects are rejected',()=>{
 const p=fixture(),visual={sizes:{p:{width:800,height:400}},regions:[{panelId:'p',purpose:'avoid',rect:[.2,.2,.2,.2]}]};
 const r=letteringRegions(p,'p',visual)[0].rect;
 assert.ok(Math.abs(r[0]-.2)<1e-8);assert.ok(Math.abs(r[1]-.35)<1e-8);assert.ok(Math.abs(r[3]-.1)<1e-8);
 assert.throws(()=>checkVisualEdit(p,{kind:'lettering',panelId:'p',args:{mode:'balloons',boxes:[{x:.2,y:.35,width:.2,height:.1}]}},visual),/重なって/);
 p.layout.imageCrops={p:{zoom:8,x:1,y:1}};visual.regions[0].purpose='subject';
 assert.throws(()=>checkVisualEdit(p,{kind:'crop',panelId:'p'},visual),/切れる/);
});
