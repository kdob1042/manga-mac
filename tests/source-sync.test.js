import {test} from 'node:test';import assert from 'node:assert/strict';
import {sourceSummary} from '../src/source-sync.js';
test('import summary reports deletions, settings and image changes but ignores commit-only changes',()=>{
 const a={id:'a',sha:'a',manifest:{work:'A'},scenes:[{id:'S1',text:'A'},{id:'S2',text:'B'}],settings:[{id:'V',text:'x'}],references:[{path:'a.png',hash:'a'}]};
 assert.equal(sourceSummary(a,{...a,id:'b',sha:'b'}).changed,false);
 const b={...a,scenes:[{id:'S1',text:'C'}],settings:[{id:'V',text:'y'}],references:[{path:'a.png',hash:'b'}]};
 assert.deepEqual(sourceSummary(a,b).scenes,['変更: S1','削除: S2']);assert.deepEqual(sourceSummary(a,b).settings,['変更: V']);assert.deepEqual(sourceSummary(a,b).references,['変更: a.png']);
 assert.equal(sourceSummary(null,a).changed,true);
});
