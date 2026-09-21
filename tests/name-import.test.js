import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {importNamePlan,parseNamePlan,MAX_NAME_PLAN_BYTES} from '../src/name-import.js';
import {tokenizeSnapshot,sourceResolver} from '../src/source-refs.js';
const sha=text=>createHash('sha256').update(text).digest('hex');
function fixture(){
  const snapshot={id:'current',repo:'fixture/stories',workId:'example',scenes:[{id:'S1',episodeId:'E1',text:'# Scene\n\n手を振る😀。\n\n「また明日」\n'}]};
  const refs=tokenizeSnapshot(snapshot).map(({source:{snapshotId,...ref}})=>ref);
  const plan={format:'manga-mac/name-plan/v1',title:'人工ネーム',stage:'name-only',readingDirection:'rtl',source:{repo:snapshot.repo,workId:snapshot.workId,episodeId:'E1',branch:'dev',commit:'a'.repeat(40),scenes:[{id:'S1',sha256:sha(snapshot.scenes[0].text)}]},panels:refs.map((r,i)=>({id:`p${i}`,sceneId:'S1',sourceRefs:[r],characterIds:['c1'],prompt:'原稿に沿った構図'})),layout:{version:1,pages:[{id:'pg',slots:refs.map((_,i)=>({id:`s${i}`,panelId:`p${i}`,points:[[.04,.04+i*.48],[.96,.04+i*.48],[.96,.46+i*.48],[.04,.46+i*.48]]}))}]}};
  const project={version:5,active:snapshot.id,snapshots:[snapshot],panels:[],characters:[{id:'c1'}],jobs:[],history:[],title:'元の作品'};
  return {project,plan};
}
const apply=({project,plan})=>importNamePlan(project,JSON.stringify(plan));
test('imports native layout, Unicode scalar references and planned status without mutation',async()=>{
  const f=fixture(),before=structuredClone(f.project),p=await apply(f);
  assert.deepEqual(f.project,before);assert.equal(p.title,'元の作品');assert.equal(p.panels.length,2);
  assert.equal(sourceResolver(p.snapshots)(p.panels[0].sourceRefs[0]),'手を振る😀。');
  assert.equal(p.panels[0].status,'planned');assert.equal(p.panels[0].image,null);
  assert.deepEqual(p.sourceApplication.units,[]);assert.deepEqual(p.layout.knownPanelIds,['p0','p1']);
  assert.equal(p.jobs[0].kind,'draft_layout');assert.equal(p.jobs[0].origin,'name-plan-import');assert.equal(p.jobs[0].draft_id,p.draftScope.id);
});
test('can split one paragraph into adjacent references',async()=>{
  const f=fixture(),ref=f.plan.panels[0].sourceRefs[0],cut=ref.startCp+2;
  f.plan.panels[0].sourceRefs=[{...ref,endCp:cut},{...ref,startCp:cut}];
  assert.equal((await apply(f)).panels[0].sourceRefs.length,2);
});
for(const [label,mutate] of [
 ['different work',f=>f.plan.source.workId='other'],
 ['different episode',f=>f.plan.source.episodeId='E2'],
 ['changed source',f=>f.project.snapshots[0].scenes[0].text+='変更'],
 ['missing source',f=>f.plan.panels[0].sourceRefs[0].endCp--],
 ['duplicate source',f=>f.plan.panels[1].sourceRefs.unshift(f.plan.panels[0].sourceRefs[0])],
 ['reordered source',f=>f.plan.panels.reverse()],
 ['out of range source',f=>f.plan.panels[0].sourceRefs[0].startCp=-1],
 ['wrong source scene',f=>f.plan.panels[0].sourceRefs[0].sceneId='other'],
 ['unknown character',f=>f.plan.panels[0].characterIds=['unknown']],
 ['duplicate panel ID',f=>f.plan.panels[1].id='p0'],
 ['overlapping slots',f=>f.plan.layout.pages[0].slots[1].points=f.plan.layout.pages[0].slots[0].points],
 ['invalid quad',f=>f.plan.layout.pages[0].slots[0].points[0][0]=-1],
 ['unassigned panel',f=>f.plan.layout.pages[0].slots.pop()],
 ['wrong reading order',f=>f.plan.layout.pages[0].slots.reverse()],
 ['media injection',f=>f.plan.panels[0].image='https://example.invalid/a.png'],
 ['prebound snapshot',f=>f.plan.panels[0].sourceRefs[0].snapshotId='forged'],
 ['existing work',f=>f.project.panels=[{id:'existing'}]],
 ['pending job',f=>f.project.jobs=[{status:'unknown'}]],
 ['malformed Unicode',f=>{f.project.snapshots[0].scenes[0].text+='\ud800';f.plan.source.scenes[0].sha256=sha(f.project.snapshots[0].scenes[0].text);}],
])test(`rejects ${label} without mutation`,async()=>{
 const f=fixture();mutate(f);const before=structuredClone(f.project);await assert.rejects(()=>apply(f));assert.deepEqual(f.project,before);
});
test('rejects invalid JSON, format and oversized file',()=>{
  assert.throws(()=>parseNamePlan('{'));assert.throws(()=>parseNamePlan('{}'));assert.throws(()=>parseNamePlan(' '.repeat(MAX_NAME_PLAN_BYTES+1)));
});
