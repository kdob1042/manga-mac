import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, defaultLettering, setLettering, validateLettering } from '../src/lettering.js';
import { drawLettering } from '../src/render.js';
test('Japanese line wrapping keeps punctuation off the start and opening brackets off the end', () => {
 const lines = wrapText('あいう「えお」、かき。', s => [...s].length, 4);
 assert.equal(lines.join(''), 'あいう「えお」、かき。');
 assert.ok(lines.every(line => !/^[、。」「]/.test(line) || line.startsWith('「')));
 assert.ok(lines.every(line => !line.endsWith('「')));
 const emoji = wrapText('あ👩‍👩‍👧‍👦いう', s => [...s].length, 2);
 assert.ok(emoji.some(line => line.includes('👩‍👩‍👧‍👦')));
});
test('lettering changes preserve artwork/source/jobs and can be undone without inference', () => {
 const panel = { id:'p',unitIds:['u1','u2'],image:'unchanged',snapshotId:'source',artwork_revision:'art' };
 const p={panels:[panel],history:[],jobs:[{id:'old'}],snapshots:[{id:'source'}]};
 const layout=defaultLettering(panel);layout.mode='balloons';
 const next=setLettering(p,'p',layout);
 assert.equal(next.panels[0].image,panel.image);assert.equal(next.panels[0].artwork_revision,'art');
 assert.deepEqual(next.jobs,p.jobs);assert.deepEqual(next.snapshots,p.snapshots);
 assert.deepEqual(next.history.at(-1).panels,p.panels);
 assert.throws(()=>validateLettering(panel,{...layout,boxes:[layout.boxes[1],layout.boxes[0]]}));
 assert.throws(()=>validateLettering(panel,{...layout,boxes:layout.boxes.map(b=>({...b,x:1}))}));
});

test('mixed lettering kinds validate while legacy boxes remain balloons', () => {
 const panel = { id:'p', unitIds:['u1','u2','u3'] };
 const layout = defaultLettering(panel);
 layout.mode = 'balloons';
 layout.boxes[0].kind = 'balloon';
 layout.boxes[1].kind = 'thought';
 layout.boxes[1].tail = null;
 layout.boxes[2].kind = 'narration';
 layout.boxes[2].shape = 'rect';
 assert.equal(validateLettering(panel, layout), layout);
 assert.equal(defaultLettering({id:'legacy',unitIds:['u']}).boxes[0].kind, undefined);
 assert.throws(() => validateLettering(panel, {...layout, boxes:layout.boxes.map((b,i)=>i===1?{...b,tail:[.5,.5]}:b)}));
 assert.throws(() => validateLettering(panel, {...layout, boxes:layout.boxes.map((b,i)=>i===2?{...b,shape:'ellipse'}:b)}));
 assert.throws(() => validateLettering(panel, {...layout, boxes:layout.boxes.map((b,i)=>i===0?{...b,kind:'unknown'}:b)}));
});

function drawingContext() {
 const calls = [];
 return {
  calls,
  measureText: value => ({ width: [...value].length * 8 }),
  beginPath: () => calls.push('beginPath'),
  moveTo: () => calls.push('moveTo'),
  lineTo: () => calls.push('lineTo'),
  closePath: () => calls.push('closePath'),
  fill: () => calls.push('fill'),
  stroke: () => calls.push('stroke'),
  rect: () => calls.push('rect'),
  roundRect: () => calls.push('roundRect'),
  ellipse: () => calls.push('ellipse'),
  fillText: () => calls.push('fillText'),
 };
}
test('thought lettering is borderless and narration lettering is rectangular', () => {
 const thought = drawingContext();
 drawLettering(thought, '心中', {x:0,y:0,width:100,height:60}, true, {kind:'thought',fontSize:20,padding:4});
 assert.deepEqual(thought.calls, ['fillText']);
 const narration = drawingContext();
 drawLettering(narration, 'ナレーション', {x:0,y:0,width:160,height:60}, true, {kind:'narration',fontSize:20,padding:4});
 assert.ok(narration.calls.includes('rect'));
 assert.ok(narration.calls.includes('fill'));
 assert.ok(narration.calls.includes('stroke'));
 assert.equal(narration.calls.includes('roundRect'), false);
 assert.equal(narration.calls.includes('moveTo'), false);
});
