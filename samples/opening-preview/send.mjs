import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {transferPreview} from '../../src/live-preview.js';

const [directory,origin,baseRevision]=process.argv.slice(2);
if(!directory||!origin||baseRevision===undefined) throw Error('Usage: node samples/opening-preview/send.mjs OUTPUT_DIR HTTPS_PREVIEW_ORIGIN BASE_REVISION_OR_null');
const endpoint=new URL(origin);
if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash) throw Error('HTTPS origin required');
if(endpoint.hostname==='live-manga.mashstock.workers.dev') throw Error('This sample must target nonproduction Preview');
const key=process.env.PREVIEW_WRITE_KEY;
if(!/^[A-Za-z0-9_-]{43,128}$/.test(key??'')) throw Error('Set a scoped PREVIEW_WRITE_KEY');
const prepared=JSON.parse(await fs.readFile(path.join(directory,'prepared.json'),'utf8'));
const headers={Authorization:`Bearer ${key}`};
if(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  headers['CF-Access-Client-Id']=process.env.CF_ACCESS_CLIENT_ID;
  headers['CF-Access-Client-Secret']=process.env.CF_ACCESS_CLIENT_SECRET;
}
async function send(method,url,body,mime) {
  const response=await fetch(new URL(url,endpoint),{method,headers:{...headers,...(mime?{'Content-Type':mime}:{})},body,redirect:'manual',signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw Error(`Preview HTTP ${response.status}; transfer remains retryable`);
  return response;
}
// Preflight all bytes before starting a server-side transfer.
const assets=new Map();
for(const a of prepared.preview.manifest.assets) {
  if(!/^assets\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(a.path)) throw Error('Invalid image asset path');
  const bytes=await fs.readFile(path.join(directory,a.path));
  if(bytes.length!==a.bytes||createHash('sha256').update(bytes).digest('hex')!==a.sha256) throw Error('Asset integrity mismatch');
  assets.set(a.id,bytes);
}
// Persist the base: retries cannot silently rebase a previously prepared transfer.
const record=path.join(directory,'destination.json'),destination={origin:endpoint.origin,baseRevision:baseRevision==='null'?null:baseRevision};
try {await fs.writeFile(record,JSON.stringify(destination),{flag:'wx',mode:0o600});}
catch(error) {if(error.code!=='EEXIST')throw error;if(JSON.stringify(JSON.parse(await fs.readFile(record,'utf8')))!==JSON.stringify(destination))throw Error('Resume with the original destination and base revision');}
const result=await transferPreview({preview:prepared.preview,baseRevision:destination.baseRevision,
  request:async(method,url,body)=>{const response=await send(method,url,body===undefined?undefined:JSON.stringify(body),body===undefined?undefined:'application/json');return response.json();},
  upload:async(url,asset)=>{await send('PUT',url,assets.get(asset.id),asset.mime);},
  onStatus:status=>console.log(status)});
const viewer=new URL(result.viewerUrl);
if(viewer.origin!==endpoint.origin||viewer.username||viewer.password) throw Error('Unexpected viewer origin');
await fs.writeFile(path.join(directory,'sent.json'),JSON.stringify(result,null,2),{mode:0o600});
console.log('Transfer committed. Viewer authentication and visual acceptance are still required.');
