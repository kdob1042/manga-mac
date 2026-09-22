import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchRepositoryNamePlan,repositoryNamePlanPath} from '../src/name-repository.js';
import {fileSchema,validateSchema,FORMAT} from '../contracts/name-plan/schema.mjs';

const snapshot={
  id:'snapshot',repo:'kdob1042/story-library',sha:'a'.repeat(40),episodeId:'E1',episodeIds:['E1'],
  library:{root:'works/example'},sync:{source_branch:'dev'},
};
test('repository plan path is inside the selected work and episode',()=>{
  assert.equal(repositoryNamePlanPath(snapshot,'E1'),'works/example/manga/E1/name-plan.json');
  assert.throws(()=>repositoryNamePlanPath(snapshot,'E2'),/取り込んだ原稿/);
});
test('repository plan fetch is pinned to the exact manuscript commit',async()=>{
  const calls=[];
  const result=await fetchRepositoryNamePlan(snapshot,'E1','secret',async(command,args)=>{
    calls.push([command,args]); return '{"format":"manga-mac/name-plan/v2"}';
  });
  assert.equal(result.commit,snapshot.sha);
  assert.deepEqual(calls,[['github_file',{repo:snapshot.repo,path:'works/example/manga/E1/name-plan.json',sha:snapshot.sha,token:'secret'}]]);
});
test('name-plan v2 source commit is optional to avoid future-commit self reference',()=>{
  const file={
    format:FORMAT,title:'fixture',readingDirection:'rtl',stage:'name-only',
    source:{repo:'kdob1042/story-library',workId:'example',branch:'dev',
      scenes:[{id:'S1',sha256:'b'.repeat(64)}],selectedAtomIds:['S1:u0:a0'],
      settingsHash:'c'.repeat(64),referencesHash:'d'.repeat(64)},
    policyVersion:'name-director/2.0.0',
    provenance:{producer:'chat-ai',model:'',editedBy:[]},
    plan:{
      workGoal:{readerQuestion:'q',emotionalArc:['arc'],payoff:'p'},
      coverage:[{atomId:'S1:u0:a0',presentation:'visual',reason:'r'}],
      beats:[{id:'b1',atomIds:['S1:u0:a0'],function:'action',tempo:'normal',readerBefore:'before',readerAfter:'after'}],
      panels:[{id:'p1',atomIds:['S1:u0:a0'],contextAtomIds:[],beatIds:['b1'],characterIds:[],role:'standard',shot:'medium',shotIntent:'intent',prompt:'prompt',silentReason:'',protect:[],gaze:'neutral'}],
      pages:[{id:'pg1',purpose:'purpose',entryBeatId:'b1',exit:{kind:'resolution',note:'done',payoffBeatIds:['b1']},tree:{type:'leaf',panelId:'p1'}}],
    },
  };
  assert.doesNotThrow(()=>validateSchema(file,fileSchema));
});
