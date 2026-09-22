import test from 'node:test';
import assert from 'node:assert/strict';
import {verticalColumns,letteringFont,validateLettering,setLettering} from '../src/lettering.js';
import {undoEdit} from '../src/edit-commands.js';

test('vertical columns retain graphemes, explicit breaks and Japanese prohibited line boundaries',()=>{
 const text='あいう「えお」、かき。';
 const columns=verticalColumns(text,4);
 assert.equal(columns.flat().join(''),text);
 assert.ok(columns.every(c=>c.length<=4&&!/^[、。」]/.test(c.join(''))&&!c.join('').endsWith('「')));
 assert.deepEqual(verticalColumns('あ👨‍👩‍👧い\n\n次',2),[['あ','👨‍👩‍👧'],['い'],[],['次']]);
 assert.throws(()=>verticalColumns('「あ」',1),/禁則/);
});

test('typography is a reversible layout edit and arbitrary font or direction fields are rejected',()=>{
 const box={id:'letter:u',unit_id:'u',x:.1,y:.1,width:.6,height:.6};
 const panel={id:'p',unitIds:['u'],image:'unchanged',artwork_revision:'art',snapshotId:'source',lettering:{mode:'balloons',boxes:[box]}};
 const p={panels:[panel],history:[],jobs:[{id:'existing'}],snapshots:[{id:'source'}],layout:{version:1,pages:[]}};
 const next=setLettering(p,'p',{mode:'balloons',boxes:[{...box,writingMode:'vertical-rl',fontFamily:'mincho'}]});
 assert.deepEqual(next.jobs,p.jobs);assert.deepEqual(next.snapshots,p.snapshots);assert.equal(next.panels[0].image,panel.image);
 assert.deepEqual(undoEdit(next).panels,p.panels);assert.deepEqual(undoEdit(undoEdit(next),true).panels,next.panels);
 for(const patch of [{fontFamily:'external font'},{writingMode:'sideways-lr'},{ruby:'かな'}])assert.throws(()=>validateLettering(panel,{mode:'balloons',boxes:[{...box,...patch}]}),/未対応/);
 assert.equal(letteringFont({}),'sans-serif');
 assert.match(letteringFont({fontFamily:'mincho'}),/Hiragino Mincho/);
});
