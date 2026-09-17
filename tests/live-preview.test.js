import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {capturePreview,preparePreview,transferPreview} from '../src/live-preview.js';
import {createProjectWriter} from '../src/project-writer.js';
import {initialLayout} from '../src/layout.js';
import {previewMatches} from '../vendor/live-manga/contracts/preview.mjs';
import {handlePreview} from '../vendor/live-manga/src/preview-worker.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const project={workId:'work',revision:7,title:'人工テスト',active:'new',snapshots:[{id:'old',repo:'test/story',scenes:[{id:'a',text:'原稿',tags:['old']}]},{id:'new',repo:'test/story',episodeId:'ep',scenes:[{id:'a',text:'更新原稿',tags:['雨']},{id:'b',text:'秘密の文脈',tags:['除外']}]}],panels:[{id:'p1',sourceRefs:[{snapshotId:'old',sceneId:'a',startCp:0,endCp:2}],contextRefs:[{snapshotId:'new',sceneId:'b',startCp:0,endCp:6}],image:null},{id:'p2',sourceRefs:[],image:'art'}],artworks:[],videoRevisions:[],jobs:[],videoShots:[],localizations:[],api_key:'SECRET',selectedBlockIds:['ignored']};
 project.layout=initialLayout(project.panels);project.layout.pages[0].id='saved-page';
 return {project,revision:crypto.randomUUID(),savedAt:'2026-09-17T00:00:00.000Z'};
}
const deps={
 image:async data=>{const id=sha(data),page=data.startsWith('layer');return {id,sha256:id,path:`assets/${id}.png`,mime:'image/png',bytes:Buffer.byteLength(data),width:page?1600:720,height:page?2260:720};},
 placeholder:async()=>'placeholder',layers:async(_panels,_project,layer)=>'layer:'+layer,probeVideo:async()=>{throw Error('pending');},
};
test('saved boundary detaches the snapshot and releases ongoing production',async()=>{
 let current=fixture().project;
 const writer=createProjectWriter({current:()=>current,save:async p=>p,accept:p=>current=p});
 const saving=writer.commit(p=>({...p,title:'saved'}));
 const capturing=capturePreview(writer,()=>current,async revision=>({revision:'frozen',savedAt:String(revision)}));
 const later=writer.commit(p=>({...p,title:'later'}));
 await saving;const captured=await capturing;await later;
 assert.equal(captured.project.title,'saved');assert.equal(current.title,'later');
 current.panels[0].image='new';assert.equal(captured.project.panels[0].image,null);
});
test('whole saved episode preserves geometry, source text, pending states and active tags without mutation',async()=>{
 const captured=fixture(),before=structuredClone(captured);
 const {preview}=await preparePreview(captured,deps);
 assert.deepEqual(captured,before);assert.equal(preview.manifest.pages[0].id,'saved-page');
 assert.deepEqual(preview.panels.map(p=>[p.id,p.art,p.lettering]),[['p1','pending','pending'],['p2','ready','none']]);
 assert.equal(preview.manifest.pages[0].panels[0].text,'原稿');
 assert.deepEqual(preview.scenes,[{id:'a',tags:['雨']}]);
 assert.equal(JSON.stringify(preview).includes('SECRET'),false);assert.equal(JSON.stringify(preview).includes('秘密の文脈'),false);
 assert.deepEqual(previewMatches(preview,['雨']).pageIds,['saved-page']);
 assert.equal(preview.manifest.pages[0].panels.length,2);
});
class FakeR2 {
 objects=new Map();counter=0;
 async put(key,input,options={}){
  const bytes=typeof input==='string'?Buffer.from(input):Buffer.from(await new Response(input).arrayBuffer()),old=this.objects.get(key);
  if(options.onlyIf?.etagDoesNotMatch==='*'&&old||options.onlyIf?.etagMatches&&options.onlyIf.etagMatches!==old?.etag)return null;
  if(options.sha256&&sha(bytes)!==options.sha256)throw Error('hash mismatch');
  const object={bytes,size:bytes.length,etag:String(++this.counter),httpEtag:`"${this.counter}"`,customMetadata:options.customMetadata??{}};this.objects.set(key,object);return {...object};
 }
 async head(key){return this.objects.get(key)??null;}
 async get(key,options={}){const v=this.objects.get(key);if(!v)return null;if(options.onlyIf?.etagMatches&&options.onlyIf.etagMatches!==v.etag)return {...v};return {...v,body:new Response(v.bytes).body,json:async()=>JSON.parse(v.bytes)};}
}
function receiver(){
 const token='w'.repeat(43),reader='r'.repeat(43),env={MEDIA:new FakeR2(),PREVIEWS_PRIVATE:'true',PREVIEW_KEYS:JSON.stringify([[token,'write'],[reader,'read']].map(([t,p])=>({sha256:sha(t),workId:'work',episodeId:'ep',permissions:[p],expiresAt:'2099-01-01T00:00:00.000Z'})))};
 const send=(path,method='GET',body,key=token,headers={})=>handlePreview(new Request('https://viewer.test'+path,{method,headers:{Authorization:`Bearer ${key}`,...headers},...(body===undefined?{}:{body})}),env);
 return {env,send,reader};
}
test('producer → pinned receiver → private viewer: interrupted upload resumes and lost commit receipt recovers',async()=>{
 const {preview,sources}=await preparePreview(fixture(),deps),{send,reader}=receiver();let uploads=0,loseReceipt=true;
 const request=async(method,path,body)=>{
  const response=await send(path,method,body?JSON.stringify(body):undefined,undefined,{'Content-Type':'application/json'});
  assert.equal(response.ok,true,await response.clone().text());
  if(method==='POST'&&loseReceipt){loseReceipt=false;throw Error('lost receipt');}return response.json();
 };
 const upload=async(path,asset)=>{uploads++;const response=await send(path,'PUT',sources[asset.id].image,undefined,{'Content-Type':asset.mime,'Content-Length':String(asset.bytes)});assert.equal(response.status,200);};
 let once=true;
 await assert.rejects(transferPreview({preview,baseRevision:null,request,upload:async(...args)=>{await upload(...args);if(once){once=false;throw Error('interrupted');}}}),/interrupted/);
 const state=await transferPreview({preview,baseRevision:null,request,upload});assert.equal(state.committed,true);
 assert.equal(uploads,preview.manifest.assets.length);
 const path=`/previews/work/ep/revisions/${preview.manifest.releaseId}/live-manga.json`;
 assert.equal((await send(path)).status,403);
 assert.deepEqual(await (await send(path,'GET',undefined,reader)).json(),preview);
 const again=await transferPreview({preview,baseRevision:null,request,upload});assert.equal(again.committed,true);assert.equal(uploads,preview.manifest.assets.length);
});
test('unconfigured private storage never reports a completed transfer',async()=>{
 const {preview}=await preparePreview(fixture(),deps),{env,send}=receiver();env.PREVIEWS_PRIVATE='false';
 const response=await send('/previews/work/ep/transfers/'+preview.manifest.releaseId,'PUT',JSON.stringify({preview,baseRevision:null}),undefined,{'Content-Type':'application/json'});
 assert.equal(response.status,503);
});
test('unassigned slots stay in place; uncomposed panels are not invented into new pages',async()=>{
 const captured=fixture();captured.project.layout.pages[0].slots[1].panelId=null;
 const {preview}=await preparePreview(captured,deps);
 assert.equal(preview.manifest.pages.length,1);assert.equal(preview.manifest.pages[0].panels.length,2);
 assert.equal(preview.panels[1].art,'pending');assert.deepEqual(preview.panels[1].sceneIds,[]);
 assert.match(preview.panels[1].id,/^preview-slot:/);
 assert.equal(preview.manifest.pages[0].panels.some(p=>p.id==='p2'),false);
 captured.project.layout.pages=[];await assert.rejects(preparePreview(captured,deps),/ページ/);
});
