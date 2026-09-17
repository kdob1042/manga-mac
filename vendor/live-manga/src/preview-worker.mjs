import {validatePreview} from '../contracts/preview.mjs';
import {parseRange} from './http-range.mjs';
const ID='[a-zA-Z0-9:_-]{1,128}', ASSET='assets/[a-f0-9]{64}\\.(?:png|jpg|webp|mp4)';
const route=new RegExp(`^/previews/(${ID})/(${ID})/(current\\.json|revisions/(${ID})/(live-manga\\.json|${ASSET})|transfers/(${ID})(?:/(commit|${ASSET}))?)$`);
const MAX_JSON=5*1024*1024;
const encoder=new TextEncoder();
const privateHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Vary':'Cookie, Authorization','Referrer-Policy':'no-referrer'};
const reply=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{...privateHeaders,'Content-Type':'application/json',...headers}});
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const reject=(status,message)=>{throw new HttpError(status,message);};
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
function equal(a,b){if(typeof a!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
const canonical=value=>JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
async function jsonRequest(request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json')) reject(415,'JSONが必要です');
  const reader=request.body?.getReader();if(!reader)reject(400,'本文がありません');
  const chunks=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>MAX_JSON)reject(413,'データが大きすぎます');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{reject(400,'JSONが不正です');}
}
async function stored(bucket,key) {
  const object=await bucket.get(key);if(!object)return null;
  if(object.size>MAX_JSON)reject(502,'保存データが不正です');
  return {value:await object.json(),etag:object.etag};
}
function bearer(request,readCookie=false){
  const authorization=request.headers.get('Authorization');
  if(authorization)return /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization)?.[1]??'';
  return readCookie?/(?:^|;\s*)manga_preview=([A-Za-z0-9_-]{43,128})(?:;|$)/.exec(request.headers.get('Cookie')??'')?.[1]??'':'';
}
async function credential(env,token,permission,workId,episodeId) {
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))reject(401,'プレビューの認証が必要です');
  let keys;try{keys=JSON.parse(env.PREVIEW_KEYS??'[]');}catch{reject(503,'プレビュー認証が未設定です');}
  if(!Array.isArray(keys)||keys.length>100)reject(503,'プレビュー認証が未設定です');
  const digest=await hash(token),now=Date.now();
  const key=keys.find(key=>key && !key.revoked && equal(key.sha256,digest) && Array.isArray(key.permissions) && key.permissions.includes(permission) && key.workId===workId && key.episodeId===episodeId && Number.isFinite(Date.parse(key.expiresAt)) && Date.parse(key.expiresAt)>now);
  if(!key)reject(403,'このプレビューの権限がありません');return key;
}
async function mutate(bucket,key,fn) {
  for(let attempt=0;attempt<6;attempt++){
    const current=await stored(bucket,key);if(!current)reject(404,'転送記録がありません');
    const next=fn(current.value);const saved=await bucket.put(key,canonical(next),{onlyIf:{etagMatches:current.etag}});
    if(saved)return next;
  }
  reject(409,'別の転送処理と競合しました。状態を確認して再開してください');
}
function stateResult(state,current,origin,prefix) {
  const id=state.preview.manifest.releaseId;
  return {transferId:id,received:state.received,missing:state.preview.manifest.assets.filter(asset=>!state.received.includes(asset.id)).map(asset=>asset.id),committed:Boolean(state.committed),current:current?.value.revision??null,viewerUrl:`${origin}/?preview=${encodeURIComponent(prefix)}&revision=${encodeURIComponent(id)}`};
}
async function serveMedia(request,bucket,key,mime,size) {
  const head=await bucket.head(key);if(!head || size!==undefined && head.size!==size)reject(404,'メディアがありません');
  const headers=new Headers({...privateHeaders,'Content-Type':mime,'Content-Length':String(head.size),'ETag':head.httpEtag,'Accept-Ranges':'bytes'});
  let range;const raw=request.headers.get('Range'),ifRange=request.headers.get('If-Range');
  if(request.method==='GET' && raw && (!ifRange || ifRange===head.httpEtag)){
    range=parseRange(raw,head.size);if(!range)return new Response(null,{status:416,headers:{...privateHeaders,'Content-Range':`bytes */${head.size}`}});
    headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${head.size}`);headers.set('Content-Length',String(range.length));
  }
  if(request.method==='HEAD')return new Response(null,{headers});
  const object=await bucket.get(key,{...(range?{range}:{}),onlyIf:{etagMatches:head.etag}});
  if(!object?.body)reject(503,'メディアを取得できません');
  return new Response(object.body,{status:range?206:200,headers});
}
export async function handlePreview(request,env) {
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/previews/') && url.pathname!=='/preview-session')return null;
  try{
    if(!env.MEDIA || env.PREVIEWS_PRIVATE!=='true')reject(503,'非公開プレビューの保存先が未設定です');
    if(request.headers.has('Origin') && request.headers.get('Origin')!==url.origin)reject(403,'別サイトからの操作は許可されていません');
    if(url.pathname==='/preview-session'){
      if(request.method!=='POST')return reply({error:'POSTが必要です'},405,{Allow:'POST'});
      const body=await jsonRequest(request);
      if(!body || Object.keys(body).some(key=>!['workId','episodeId','token'].includes(key)) || (typeof body.workId!=='string'||!new RegExp(`^${ID}$`).test(body.workId)) || (typeof body.episodeId!=='string'||!new RegExp(`^${ID}$`).test(body.episodeId)))reject(400,'認証対象が不正です');
      const key=await credential(env,body.token,'read',body.workId,body.episodeId);
      const age=Math.max(1,Math.min(8*3600,Math.floor((Date.parse(key.expiresAt)-Date.now())/1000)));
      return reply({authenticated:true},200,{'Set-Cookie':`manga_preview=${body.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`});
    }
    const m=route.exec(url.pathname);if(!m)reject(404,'プレビューがありません');
    const [,work,episode,,revision,assetPath,transfer,operation]=m,prefix=`${work}/${episode}`,root=`previews/${prefix}/`,bucket=env.MEDIA;
    await credential(env,bearer(request,!transfer),transfer?'write':'read',work,episode);
    if(!transfer){
      if(!['GET','HEAD'].includes(request.method))return reply({error:'読み取り専用です'},405,{Allow:'GET, HEAD'});
      if(!revision){const current=await stored(bucket,root+'current.json');if(!current)reject(404,'転送済みのプレビューがありません');return request.method==='HEAD'?new Response(null,{headers:privateHeaders}):reply({revision:current.value.revision});}
      const key=`${root}revisions/${revision}/`,saved=await stored(bucket,key+'live-manga.json');if(!saved)reject(404,'転送は確定していません');
      const preview=validatePreview(saved.value);if(preview.manifest.workId!==work || preview.manifest.episodeId!==episode || preview.manifest.releaseId!==revision)reject(502,'保存版の対応が不正です');
      if(assetPath==='live-manga.json')return serveMedia(request,bucket,key+assetPath,'application/json');
      const asset=preview.manifest.assets.find(asset=>asset.path===assetPath);if(!asset)reject(404,'参照されていないメディアです');
      return serveMedia(request,bucket,key+assetPath,asset.mime,asset.bytes);
    }
    const stateKey=`${root}transfers/${transfer}.json`,revisionKey=`${root}revisions/${transfer}/`,currentKey=root+'current.json';
    if(!operation && request.method==='PUT'){
      const body=await jsonRequest(request);
      if(!body || Object.keys(body).length!==2 || !Object.hasOwn(body,'preview') || !Object.hasOwn(body,'baseRevision') || body.baseRevision!==null && (typeof body.baseRevision!=='string'||!new RegExp(`^${ID}$`).test(body.baseRevision)))reject(400,'転送要求が不正です');
      let preview;try{preview=validatePreview(body.preview);}catch{reject(400,'プレビュー形式が不正です');}
      if(preview.manifest.workId!==work || preview.manifest.episodeId!==episode || preview.manifest.releaseId!==transfer)reject(400,'転送先と保存版が一致しません');
      const digest=await hash(canonical(preview)),existing=await stored(bucket,stateKey),current=await stored(bucket,currentKey);
      if(existing){if(existing.value.digest!==digest || existing.value.baseRevision!==body.baseRevision)reject(409,'転送IDを別の内容には再利用できません');return reply(stateResult(existing.value,current,url.origin,prefix));}
      if((current?.value.revision??null)!==body.baseRevision)reject(409,'転送先に新しい版があります。確認してから転送してください');
      const state={preview,digest,received:[],baseRevision:body.baseRevision,baseETag:current?.etag??null,committed:false};
      if(!await bucket.put(stateKey,canonical(state),{onlyIf:{etagDoesNotMatch:'*'}}))reject(409,'転送を開始済みです。状態を確認してください');
      return reply(stateResult(state,current,url.origin,prefix),201);
    }
    const saved=await stored(bucket,stateKey);if(!saved)reject(404,'転送記録がありません');const state=saved.value;
    if(!operation && request.method==='GET')return reply(stateResult(state,await stored(bucket,currentKey),url.origin,prefix));
    if(operation?.startsWith('assets/') && request.method==='PUT'){
      const asset=state.preview.manifest.assets.find(asset=>asset.path===operation);if(!asset)reject(400,'転送対象外のメディアです');
      if(Number(request.headers.get('Content-Length'))!==asset.bytes || request.headers.get('Content-Type')!==asset.mime || !request.body)reject(400,'メディアの型・サイズが一致しません');
      const key=revisionKey+operation,head=await bucket.head(key);
      if(head){if(head.size!==asset.bytes || head.customMetadata?.sha256!==asset.sha256)reject(409,'保存済みメディアが一致しません');}
      else{
        let bytes=0;
        const stream=request.body.pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>asset.bytes)throw Error('size exceeded');controller.enqueue(chunk);},flush(){if(bytes!==asset.bytes)throw Error('size mismatch');}}));
        try{const result=await bucket.put(key,stream,{onlyIf:{etagDoesNotMatch:'*'},sha256:asset.sha256,httpMetadata:{contentType:asset.mime},customMetadata:{sha256:asset.sha256}});if(!result){const concurrent=await bucket.head(key);if(concurrent?.size!==asset.bytes||concurrent.customMetadata?.sha256!==asset.sha256)reject(409,'メディア転送が競合しました');}}
        catch(error){if(error instanceof HttpError)throw error;reject(400,'メディアのサイズまたはハッシュ検証に失敗しました');}
      }
      const next=await mutate(bucket,stateKey,latest=>({...latest,received:[...new Set([...latest.received,asset.id])]}));
      return reply(stateResult(next,await stored(bucket,currentKey),url.origin,prefix));
    }
    if(operation==='commit' && request.method==='POST'){
      if(state.preview.manifest.assets.some(asset=>!state.received.includes(asset.id)))reject(409,'メディアの転送が完了していません');
      let current=await stored(bucket,currentKey);
      if(state.committed)return reply(stateResult(state,current,url.origin,prefix));
      const finalKey=revisionKey+'live-manga.json';
      const result=await bucket.put(finalKey,canonical(state.preview),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},customMetadata:{sha256:state.digest}});
      if(!result){const head=await bucket.head(finalKey);if(head?.customMetadata?.sha256!==state.digest)reject(409,'保存版の内容が一致しません');}
      if(current?.value.revision!==transfer){
        if((current?.value.revision??null)!==state.baseRevision)reject(409,'より新しいプレビューを保持しました。この転送版への切替は行っていません');
        const updated=await bucket.put(currentKey,canonical({revision:transfer,digest:state.digest}),{onlyIf:state.baseETag?{etagMatches:state.baseETag}:{etagDoesNotMatch:'*'}});
        if(!updated){current=await stored(bucket,currentKey);if(current?.value.revision!==transfer)reject(409,'最新版の切替が競合しました');}
      }
      const next=await mutate(bucket,stateKey,latest=>({...latest,committed:true}));
      return reply(stateResult(next,await stored(bucket,currentKey),url.origin,prefix));
    }
    return reply({error:'未対応の操作です'},405);
  }catch(error){return reply({error:error instanceof HttpError?error.message:'プレビュー処理を完了できませんでした'},error instanceof HttpError?error.status:503);}
}
