import React, { useState, useEffect } from 'react';
import { call } from './bridge';
import { liveCall, liveWork } from './live-blender';
export default function LiveBlenderSettings({ project, run, notify }) {
  const [form, setForm] = useState({port:9877, token:'', instance:'', file:'', scene:'Scene', view_layer:'ViewLayer'});
  const [state, setState] = useState(null), [preview, setPreview] = useState(null);
  const work = liveWork(project);
  useEffect(() => { let active=true; setState(null); liveCall(call, project, 'status').then(value=>{if(active)setState(value);}).catch(()=>{}); return ()=>{active=false;}; }, [work]);
  const perform = action => run('開いているBlenderへ接続中', async () => {
    try { const result = await liveCall(call, project, action, action === 'connect' ? form : {}); setState(result); if(action === 'connect') setForm(f => ({...f,token:''})); notify(action === 'disconnect' ? 'live接続を切断しました。Blenderは開いたままです。' : '同じGUIのlive状態を確認しました'); }
    catch(e) { setState(null); throw e; }
  });
  return <details><summary>開いているBlenderへlive接続</summary>
    <p>Blenderの「Manga Live」で開始し、表示されたinstance・tokenと対象を入力してください。接続だけでは編集しません。</p>
    {Object.entries(form).map(([key,value]) => <label key={key}>{({port:'ローカルポート',token:'接続トークン',instance:'Blender instance',file:'現在開いているfile（未保存なら空欄）',scene:'Scene',view_layer:'View Layer'})[key]}<input type={key==='token'?'password':key==='port'?'number':'text'} autoComplete="off" value={value} onChange={e=>setForm({...form,[key]:key==='port'?Number(e.target.value):e.target.value})}/></label>)}
    <button onClick={()=>perform('connect')}>live接続する</button><button onClick={()=>perform('status')}>live疎通確認</button><button onClick={()=>perform('disconnect')}>live切断（再接続前）</button>
    {state && <><button onClick={()=>run('live状態を観測中',async()=>setState(await liveCall(call,project,'observe',{scope:'summary'})))}>現在の選択・frameを観測</button>
      {['viewport','camera'].map(scope=><button key={scope} onClick={()=>run('live画像を取得中',async()=>setPreview(await liveCall(call,project,'observe',{scope})))}>{scope==='viewport'?'Viewport画像':'Cameraプレビュー'}</button>)}</>}
    {preview && <figure><img style={{maxWidth:'100%'}} src={preview.image} alt={preview.image_kind}/><figcaption>{preview.image_kind} / revision {preview.revision}</figcaption></figure>}
    {state?.selection && <p>Frame {state.frame} ／ {state.object_mode} ／ 選択：{state.selection.map(o=>o.name).join(', ')}</p>}
    {state && <p>LIVE ／ {state.file || '未保存'} ／ {state.scene} ／ {state.view_layer} ／ Camera: {state.camera ?? 'なし'} ／ {state.control}</p>}
  </details>;
}
