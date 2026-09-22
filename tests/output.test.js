import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputSize, outputResolution } from '../src/output.js';

const project = () => ({panels:[{id:'a',image:'a'},{id:'b',image:null}], layout:{pages:[{id:'p',slots:[
  {id:'s1',panelId:'a',points:[[0,0],[1,0],[1,1],[0,1]]},
]}],imageCrops:{}}});

test('bounded output dimensions preserve composition ratio and legacy default', () => {
  assert.deepEqual(outputSize(), {width:1600,height:2260});
  assert.deepEqual(outputSize({width:800}), {width:800,height:1130});
  assert.deepEqual(outputSize({width:3200}), {width:3200,height:4520});
  for (const width of [0, NaN, Infinity, -800, '1600', 999999]) assert.throws(() => outputSize({width}));
});

test('resolution warning reflects actual crop and chosen output without mutating project', () => {
  const p=project(), before=JSON.stringify(p), dimensions=()=>({width:2260,height:2260});
  assert.deepEqual(outputResolution(p,{width:1600},dimensions),[]);
  const large=outputResolution(p,{width:3200},dimensions);
  assert.equal(large.length,1);assert.equal(large[0].scale,2);
  assert.equal(large[0].requiredHeight,4520);assert.equal(JSON.stringify(p),before);
  p.layout.imageCrops.a={zoom:2,x:.5,y:.5};
  assert.equal(outputResolution(p,{width:1600},dimensions)[0].scale,2);
  p.layout.imageCrops.a={fit:'contain',zoom:1,x:.5,y:.5};
  assert.deepEqual(outputResolution(p,{width:1600},dimensions),[]);
});

test('unknown dimensions are not marked sufficient and missing images remain strict-render errors', () => {
  const p=project();
  assert.equal(outputResolution(p,{},()=>{throw Error('invalid PNG');})[0].unknown,true);
  p.panels[0].image=null;
  assert.deepEqual(outputResolution(p,{},()=>{throw Error('should not read');}),[]);
});
