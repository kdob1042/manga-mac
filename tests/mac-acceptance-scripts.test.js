import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const preflight=new URL('../scripts/mac-acceptance-preflight.sh',import.meta.url).pathname;
const smoke=new URL('../scripts/mac-acceptance-smoke.sh',import.meta.url).pathname;
const session='90c9c665-5a6c-4bd4-b850-3b4826f138ba';
async function fixture(t,fail=false){
  const dir=await mkdtemp(path.join(os.tmpdir(),'acceptance spaces '));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const executable=path.join(dir,'Manga Mac executable');
  await writeFile(executable,'#!/bin/sh\nprintf "%s\\n" "$@" >> "$TEST_LOG"\nif [ "$1" = --acceptance-preflight ]; then echo "{\\"fixture\\":true}"; exit '+(fail?'2':'0')+'; fi\n',{mode:0o755});
  return {dir,executable,log:path.join(dir,'calls.log')};
}
test('preflight only asks the chosen executable for diagnostics (spaces remain literal)',async t=>{
  const f=await fixture(t);
  const r=spawnSync('sh',[preflight,'--executable',f.executable],{env:{PATH:process.env.PATH,TEST_LOG:f.log},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{fixture:true});
  assert.equal(await readFile(f.log,'utf8'),'--acceptance-preflight\n');
});
test('smoke refuses to start after required preflight failure',async t=>{
  const f=await fixture(t,true);
  const r=spawnSync('sh',[smoke,'--executable',f.executable,'--session',session],{env:{PATH:process.env.PATH,TEST_LOG:f.log},encoding:'utf8'});
  assert.equal(r.status,2);assert.equal(await readFile(f.log,'utf8'),'--acceptance-preflight\n');
});
test('smoke launches exactly the specified isolated session after successful diagnostics',async t=>{
  const f=await fixture(t);
  const r=spawnSync('sh',[smoke,'--executable',f.executable,'--session',session],{env:{PATH:process.env.PATH,TEST_LOG:f.log},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.equal(await readFile(f.log,'utf8'),'--acceptance-preflight\n--acceptance-session\n'+session+'\n');
});
test('missing executable and unsafe session do not start the application',async t=>{
  const f=await fixture(t);
  const missing=spawnSync('sh',[preflight,'--executable',path.join(f.dir,'absent')],{encoding:'utf8'});
  assert.equal(missing.status,2);assert.equal(JSON.parse(missing.stdout).status,'NOT_CONFIGURED');
  const unsafe=spawnSync('sh',[smoke,'--executable',f.executable,'--session','../../normal-work'],{env:{PATH:process.env.PATH,TEST_LOG:f.log},encoding:'utf8'});
  assert.equal(unsafe.status,64);assert.equal(await readFile(f.log,'utf8'),'--acceptance-preflight\n');
});
test('packaged provenance identifies the actual app/helper/DMG bytes and refuses overwrite',async t=>{
  const f=await fixture(t);
  const app='bundle/macos/Manga Mac.app/Contents/MacOS';
  for(const dir of [app,'bundle/dmg','scripts','src','helper'])await mkdir(path.join(f.dir,dir),{recursive:true});
  for(const [file,bytes] of [[app+'/manga-mac','app'],[app+'/manga-engine','helper'],['bundle/dmg/test.dmg','dmg'],['src/media-registry.json','{}'],['helper/Package.resolved','{}']])await writeFile(path.join(f.dir,file),bytes);
  await copyFile(preflight,path.join(f.dir,'scripts/mac-acceptance-preflight.sh'));
  await copyFile(smoke,path.join(f.dir,'scripts/mac-acceptance-smoke.sh'));
  const git=args=>{const r=spawnSync('git',args,{cwd:f.dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init']);git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
  const pack=new URL('../scripts/package-mac-acceptance.mjs',import.meta.url).pathname;
  const args=[pack,'bundle','kit'];
  const r=spawnSync(process.execPath,args,{cwd:f.dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const manifest=JSON.parse(await readFile(path.join(f.dir,'kit/build-provenance.json'),'utf8'));
  assert.equal(manifest.appSha,git(['rev-parse','HEAD']));assert.equal(manifest.sourceDirty,false);
  assert.equal(manifest.files.find(f=>f.file.endsWith('/manga-engine')).sha256,createHash('sha256').update('helper').digest('hex'));
  assert.equal(manifest.files.length,3);
  assert.notEqual(spawnSync(process.execPath,args,{cwd:f.dir}).status,0);
});
