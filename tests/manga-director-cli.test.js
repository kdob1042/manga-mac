import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fileFixture} from './name-plan-fixture.mjs';

const cli=fileURLToPath(new URL('../tools/manga-director/validate.mjs',import.meta.url));

async function runWith(change=()=>{}) {
  const root=await mkdtemp(join(tmpdir(),'manga-director-'));
  try {
    const {project,snapshot,file}=await fileFixture(2);
    const bundle={
      manifest:{format:'story-source/v1',work:{title:'公開fixture'},episodes:[
        {id:'P01',title:'第一話',scenes:[{id:'S01',path:'manuscript/p01/p01-01.md'}]},
      ],settings:[],characters:[]},
      files:{'manuscript/p01/p01-01.md':snapshot.scenes[0].text},
    };
    change({project,file,bundle});
    const entries=[['project.json',project],['name-plan.json',file],['source.json',bundle]];
    for(const [name,value] of entries) await writeFile(join(root,name),JSON.stringify(value));
    const before=await Promise.all(entries.map(([name])=>readFile(join(root,name),'utf8')));
    const result=spawnSync(process.execPath,[cli,'--project',join(root,'project.json'),'--plan',join(root,'name-plan.json'),'--source-bundle',join(root,'source.json')],{
      encoding:'utf8',env:{PATH:process.env.PATH??''},timeout:10000,
    });
    assert.ifError(result.error);
    assert.deepEqual(await Promise.all(entries.map(([name])=>readFile(join(root,name),'utf8'))),before);
    return result;
  } finally {await rm(root,{recursive:true,force:true});}
}

test('real CLI process uses production source validation and name importer with no host or API key',async()=>{
  const result=await runWith();
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.ok,true);
  assert.equal(report.format,'manga-mac/name-plan/v2');
  assert.equal(report.sourceScenes,1);
  assert.equal(report.panels,2);
  assert.equal(report.pages,1);
  assert.match(report.fileHash,/^[a-f0-9]{64}$/);
});

test('real CLI process rejects unknown name version, absent source file and source/hash drift',async()=>{
  for(const change of [
    ({file})=>{file.format='manga-mac/name-plan/v3';},
    ({bundle})=>{delete bundle.files['manuscript/p01/p01-01.md'];},
    ({bundle})=>{bundle.files['manuscript/p01/p01-01.md']='# Scene\n\n別の本文';},
  ]) {
    const result=await runWith(change);
    assert.equal(result.status,1);
    assert.equal(JSON.parse(result.stderr).ok,false);
    assert.equal(result.stdout,'');
  }
});
