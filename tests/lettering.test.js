import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, defaultLettering, setLettering, validateLettering, letteringKind } from '../src/lettering.js';
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

test('narration frames are valid in-panel lettering with an explicit kind', () => {
 const panel = { id:'p',unitIds:['u1','u2'],image:'unchanged',snapshotId:'source' };
 const layout = defaultLettering(panel);
 layout.mode = 'balloons';
 layout.boxes[0] = {...layout.boxes[0],kind:'narration',shape:'rect',tail:null,x:.12,y:.18,width:.36,height:.18};
 layout.boxes[1] = {...layout.boxes[1],kind:'balloon',shape:'round',tail:[.8,.72],x:.54,y:.52,width:.32,height:.2};
 assert.doesNotThrow(() => validateLettering(panel, layout));
 assert.equal(letteringKind(layout.boxes[0]), 'narration');
 assert.equal(letteringKind(layout.boxes[1]), 'balloon');
 assert.throws(() => validateLettering(panel, {...layout,boxes:[{...layout.boxes[0],kind:'unknown'},layout.boxes[1]]}), /未対応/);
});
