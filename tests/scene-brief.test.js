import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSceneBrief} from '../src/scene-brief.js';
const target={instance:'i',epoch:'e',revision:2,file:'/working.blend',scene:'Scene',view_layer:'ViewLayer'};
const panel={id:'p',snapshotId:'s',sceneId:'scene',unitIds:['scene:u0'],characterIds:['c'],live_binding:target,prompt:'正面から'};
const project={snapshots:[{id:'s',sha:'commit',scenes:[{id:'scene',text:'必要な原文。\n\n別の原文。'}]}],characters:[{id:'c',image:'data:image/png;base64,YQ==',name:'人物',description:'服装'},{id:'other',image:'private'}],token:'secret',panels:[panel]};
test('brief contains exact scoped text and actual reference bytes, not project credentials',async()=>{
 const {brief,files}=await buildSceneBrief(project,panel,target);
 assert.equal(brief.source.text,'必要な原文。');assert.equal(brief.references.length,1);
 assert.equal(new TextDecoder().decode(files[0].bytes),'a');
 assert.equal(JSON.stringify(brief).includes('secret'),false);assert.equal(JSON.stringify(brief).includes('private'),false);
 assert.equal(brief.live.file,'/working.blend');assert.equal(project.panels[0],panel);
});
test('stale GUI and changed reference bytes cannot be handed off as the intended version',async()=>{
 await assert.rejects(buildSceneBrief(project,panel,{...target,epoch:'new'}),/target_unknown/);
 await assert.rejects(buildSceneBrief({...project,characters:[{...project.characters[0],hash:'bad'}]},panel,target),/版が一致/);
});
