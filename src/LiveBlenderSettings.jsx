import React, { useState, useEffect } from 'react';
import { call } from './bridge';
import { liveCall, liveWork } from './live-blender';
export default function LiveBlenderSettings({ project, run, notify }) {
  const [form, setForm] = useState({port:9877, token:'', instance:'', file:'', scene:'Scene', view_layer:'ViewLayer'});
  const [state, setState] = useState(null);
  const work = liveWork(project);
  useEffect(() => { setState(null); liveCall(call, project, 'disconnect').catch(() => {}); }, [work]);
  const perform = action => run('開いているBlenderへ接続中', async () => {
    try { const result = await liveCall(call, project, action, action === 'connect' ? form : {}); setState(result); if(action === 'connect') setForm(f => ({...f,token:''})); notify(action === 'disconnect' ? 'live接続を切断しました。Blenderは開いたままです。' : '同じGUIのlive状態を確認しました'); }
    catch(e) { setState(null); throw e; }
  });
  return <details><summary>開いているBlenderへlive接続</summary>
    <p>Blenderの「Manga Live」で開始し、表示されたinstance・tokenと対象を入力してください。接続だけでは編集しません。</p>
    {Object.entries(form).map(([key,value]) => <label key={key}>{({port:'ローカルポート',token:'接続トークン',instance:'Blender instance',file:'現在開いているfile（未保存なら空欄）',scene:'Scene',view_layer:'View Layer'})[key]}<input type={key==='token'?'password':key==='port'?'number':'text'} autoComplete="off" value={value} onChange={e=>setForm({...form,[key]:key==='port'?Number(e.target.value):e.target.value})}/></label>)}
    <button onClick={()=>perform('connect')}>live接続する</button><button onClick={()=>perform('status')}>live疎通確認</button><button onClick={()=>perform('disconnect')}>live切断（再接続前）</button>
    {state && <p>LIVE ／ {state.file || '未保存'} ／ {state.scene} ／ {state.view_layer} ／ Camera: {state.camera ?? 'なし'} ／ {state.control}</p>}
  </details>;
}
