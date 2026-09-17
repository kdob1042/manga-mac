// Actual renderer/native package -> unchanged pinned Worker -> authenticated media reads.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {handlePreview} from '../vendor/live-manga/src/preview-worker.mjs';
import {validatePreview,previewMatches} from '../vendor/live-manga/contracts/preview.mjs';
import {transferPreview} from '../src/live-preview.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
class FakeR2{
 objects=new Map();counter=0;
 async put(key,input,options={}){
  const bytes=typeof input==='string'?Buffer.from(input):Buffer.from(await new Response(input).arrayBuffer()),old=this.objects.get(key);
  if(options.onlyIf?.etagDoesNotMatch==='*'&&old||options.onlyIf?.etagMatches&&options.onlyIf.etagMatches!==old?.etag)return null;
  if(options.sha256&&sha(bytes)!==options.sha256)throw Error('checksum mismatch');
  const object={bytes,size:bytes.length,etag:String(++this.counter),httpEtag:`"${this.counter}"`,customMetadata:options.customMetadata??{}};this.objects.set(key,object);return {...object};
 }
 async head(key){return this.objects.get(key)??null;}
 async get(key,options={}){const v=this.objects.get(key);if(!v)return null;if(options.onlyIf?.etagMatches&&options.onlyIf.etagMatches!==v.etag)return {...v};return {...v,body:new Response(v.bytes).body,json:async()=>JSON.parse(v.bytes)};}
}
export async function exercisePreviewPackage(path){
 const preview=validatePreview(JSON.parse(await readFile(join(path,'preview.json'),'utf8'))),m=preview.manifest;
 const writer='w'.repeat(43),reader='r'.repeat(43);
 const env={MEDIA:new FakeR2(),PREVIEWS_PRIVATE:'true',PREVIEW_KEYS:JSON.stringify([[writer,'write'],[reader,'read']].map(([token,permission])=>({sha256:sha(token),workId:m.workId,episodeId:m.episodeId,permissions:[permission],expiresAt:'2099-01-01T00:00:00.000Z'})))};
 const send=(path,method='GET',body,token=writer,headers={})=>handlePreview(new Request('https://preview.test'+path,{method,headers:{Authorization:`Bearer ${token}`,...headers},...(body===undefined?{}:{body})}),env);
 const request=async(method,path,body)=>{const r=await send(path,method,body?JSON.stringify(body):undefined,writer,{'Content-Type':'application/json'});assert.equal(r.ok,true,await r.clone().text());return r.json();};
 let uploaded=0;
 const upload=async(url,asset)=>{const bytes=await readFile(join(path,asset.path));assert.equal(sha(bytes),asset.sha256);const r=await send(url,'PUT',bytes,writer,{'Content-Type':asset.mime,'Content-Length':String(bytes.length)});assert.equal(r.status,200);uploaded++;};
 const result=await transferPreview({preview,baseRevision:null,request,upload});assert.equal(result.committed,true);
 const root=`/previews/${m.workId}/${m.episodeId}/revisions/${m.releaseId}/`;
 assert.equal((await send(root+'live-manga.json')).status,403);
 assert.deepEqual(await (await send(root+'live-manga.json','GET',undefined,reader)).json(),preview);
 for(const asset of m.assets){const response=await send(root+asset.path,'GET',undefined,reader);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),asset.sha256);}
 assert(m.assets.some(a=>a.mime==='video/mp4'));assert(preview.panels.some(p=>p.art==='pending'));assert(preview.panels.some(p=>p.lettering==='none'));
 assert.equal(JSON.stringify(preview).includes('PRIVATE_PREVIEW_CANARY'),false);
 const before=uploaded;assert.equal(previewMatches(preview,[]).pageIds.length,2);assert.equal(previewMatches(preview,['雨']).pageIds.length,2);assert.equal(previewMatches(preview,['図書館']).pageIds.length,2);assert.equal(previewMatches(preview,['雨','図書館'],'all').pageIds.length,0);
 await transferPreview({preview,baseRevision:null,request,upload});assert.equal(uploaded,before);
 console.log(`LIVE_PREVIEW_VERIFIED=${result.viewerUrl} (${uploaded} verified assets)`);
}
