import React,{useEffect,useRef,useState} from 'react';
import {call,desktop} from './bridge.js';
import {capturePreview,preparePreview,previewContentKey} from './live-preview.js';
import {imageHash} from './revisions.js';
import {imageOf} from './canvas-image.js';
import {pageLayers} from './render.js';

async function image(data){
  const id=await imageHash(data),im=await imageOf(data),mime=data.slice(5,data.indexOf(';'));
  const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];
  if(!ext)throw Error('プレビュー画像の形式が不正です');
  return {id,sha256:id,path:`assets/${id}.${ext}`,mime,bytes:atob(data.split(',')[1]).length,width:im.width,height:im.height};
}
function placeholder(){
  const canvas=document.createElement('canvas');canvas.width=720;canvas.height=720;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#f2f0eb';ctx.fillRect(0,0,720,720);
  ctx.fillStyle='#777';ctx.font='32px sans-serif';ctx.fillText('未作画',32,64);
  return canvas.toDataURL('image/png');
}
const labels={idle:'未転送',preparing:'準備中',transferring:'転送中',verifying:'検証中',sent:'転送済み',failed:'失敗・再開可能'};
export const prepareBrowserPreview=captured=>preparePreview(captured,{image,placeholder,probeVideo:videoRevision=>call('live_preview_video_probe',{revision:captured.revision,videoRevision}),layers:(panels,p,layer,page,crops)=>pageLayers(panels,p.snapshots,p.localizations,p.output_locale,layer,page,true,crops)});
export default function LivePreviewControls({writer,current,ready}){
  const [origin,setOrigin]=useState(''),[token,setToken]=useState(''),[base,setBase]=useState('');
  const [revision,setRevision]=useState(''),[status,setStatus]=useState('idle'),[error,setError]=useState(''),[url,setUrl]=useState('');
  const captured=useRef(null),gate=useRef(false);
  const lastContent=useRef(null),sendingContent=useRef(null),lastRevision=useRef(null);
  const [records,setRecords]=useState([]);
  const workId=current.current.workId,episodeId=current.current.snapshots.find(s=>s.id===current.current.active)?.episodeId||'publication';
  useEffect(()=>{if(!ready||!desktop())return;let active=true;call('live_preview_list',{workId,episodeId}).then(async rows=>{if(!active)return;setRecords(rows);const last=rows.at(-1);if(last){setRevision(last.revision);setOrigin(last.destination?.origin??'');setBase(last.destination?.baseRevision??'');if(last.received){const saved=await call('live_preview_restore',{revision:last.revision,workId,episodeId});if(!active)return;lastContent.current=previewContentKey(saved.project);lastRevision.current=last.received.current;setStatus('sent');}}}).catch(()=>{});return()=>{active=false;};},[ready,workId,episodeId]);
  const working=['preparing','transferring','verifying'].includes(status);
  async function transfer(resume){
    if(gate.current)return;gate.current=true;setError('');setUrl('');
    const workId=current.current.workId,episodeId=current.current.snapshots.find(s=>s.id===current.current.active)?.episodeId||'publication';
    try{
      const endpoint=new URL(origin);
      if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw Error('承認するHTTPSのWorker originを入力してください');
      if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))throw Error('作品・話に限定した転送用キーを入力してください');
      let id=revision;
      if(!resume){
        if(status==='sent'&&lastRevision.current)setBase(lastRevision.current);
        setStatus('preparing');
        captured.current=await capturePreview(writer,()=>current.current,revision=>call('live_preview_capture',{revision,savedAt:new Date().toISOString()}));
        id=captured.current.revision;setRevision(id);
        sendingContent.current=previewContentKey(captured.current.project);
      }
      if(resume&&!captured.current){
        const recovered=await call('live_preview_restore',{revision:id,workId,episodeId});
        sendingContent.current=previewContentKey(recovered.project);
        if(!recovered.prepared)captured.current=recovered;
      }
      if(captured.current?.revision===id){
        setStatus('preparing');
        const prepared=await prepareBrowserPreview(captured.current);
        await call('live_preview_stage',{request:prepared});
        captured.current=null;
      }
      setStatus('transferring');
      const result=await call('live_preview_send',{revision:id,origin:endpoint.origin,token,workId,episodeId,baseRevision:!resume&&status==='sent'&&lastRevision.current?lastRevision.current:base||null});
      setStatus('verifying');
      const viewer=new URL(result.viewerUrl);
      if(viewer.origin!==endpoint.origin||viewer.username||viewer.password||result.revision!==id)throw Error('閲覧先または転送版が一致しません');
      setUrl(viewer.href);setStatus('sent');
      lastContent.current=sendingContent.current;lastRevision.current=result.current;
    }catch(e){setStatus('failed');setError(e.message??String(e));}finally{gate.current=false;}
  }
  return <details className="source-reader"><summary>Live Mangaへ非公開プレビューを転送</summary>
    <p>保存サービス: Cloudflare R2 · 非公開preview · 対象: {current.current.title} / {current.current.snapshots.find(s=>s.id===current.current.active)?.episodeId??'publication'}</p>
    <p>保存済みの話全体を転送します。タグや選択中のコマでは絞り込みません。制作は転送中も続けられます。</p>
    <p>ページ未配置のコマ: {current.current.panels.filter(p=>!current.current.layout?.pages.some(pg=>pg.slots.some(s=>s.panelId===p.id))).length}（未構成範囲は転送しません）</p>
    {lastContent.current&&lastContent.current!==previewContentKey(current.current)&&<p role="status">前回転送後に変更あり</p>}
    <label>承認するWorker origin <input value={origin} disabled={working} onChange={e=>{setOrigin(e.target.value);setToken('');lastRevision.current=null;setStatus('idle');setUrl('');}} placeholder="https://preview.example.com"/></label>
    <label>転送用キー <input type="password" autoComplete="off" value={token} disabled={working} onChange={e=>setToken(e.target.value)}/></label>
    <p>キーはこの画面のメモリだけに保持します。閲覧には別の読み取り用認証が必要です。</p>
    <label>転送先の現在版（初回は空欄） <input value={base} disabled={working} onChange={e=>setBase(e.target.value)}/></label>
    <button disabled={!ready||!desktop()||working||!current.current.panels.length} onClick={()=>transfer(false)}>この転送先へ保存済みの話を転送</button>
    <label>再開する転送版 <input value={revision} disabled={working} onChange={e=>{captured.current=null;setRevision(e.target.value);}}/></label>
    {!!records.length&&<label>保存した転送記録<select disabled={working} value={revision} onChange={e=>{const row=records.find(r=>r.revision===e.target.value);if(!row)return;captured.current=null;setRevision(row.revision);setOrigin(row.destination?.origin??'');setToken('');lastRevision.current=null;setBase(row.destination?.baseRevision??'');setStatus('idle');setUrl('');}}><option value="">転送版を選択</option>{records.map(r=><option key={r.revision} value={r.revision}>{r.savedAt} · {r.received?'受信確認済み':'未完了'} · {r.revision}</option>)}</select></label>}
    <button disabled={!ready||!desktop()||working||!revision} onClick={()=>transfer(true)}>不足分から再開</button>
    <button disabled={status!=='transferring'} onClick={()=>call('live_preview_cancel',{revision}).then(()=>setError('送信中のアセットを回収して停止します。確定済みの場合は結果を確認します。')).catch(e=>setError(String(e)))}>転送を停止</button>
    <output aria-live="polite">{labels[status]}</output>{error&&<p role="alert">{error}</p>}
    {url&&<p><a href={url} target="_blank" rel="noreferrer">転送した版を閲覧する</a>（読み取り用認証が必要）</p>}
  </details>;
}
