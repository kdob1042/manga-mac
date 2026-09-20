import React, {useState,useEffect} from 'react';
import {call,desktop} from './bridge';
import LiveBlenderSettings from './LiveBlenderSettings';
export default function BlenderSettings({ disabled, run, notify, project }) {
  const [legacy,setLegacy]=useState(null);
  useEffect(()=>{if(desktop())call('blender_latest').then(setLegacy).catch(()=>{});},[]);
  return <fieldset disabled={disabled}><legend>Blender 4.5.13 · GUI接続</legend>
    <LiveBlenderSettings project={project} run={run} notify={notify}/>
    {legacy?.jobs?.filter(j=>['unknown','candidate','running'].includes(j.status)).map(j=><div key={j.id}><p>旧保存処理の確認 {j.id}</p>{['adopt','abandon'].map(action=><button key={action} disabled={j.status==='running'||(action==='adopt'&&j.expected_revision!==legacy.revision)} onClick={()=>run('旧保存結果を確認中',async()=>{setLegacy(await call('blender_recover',{sessionId:legacy.session_id,requestId:j.id,expectedRevision:legacy.revision,action}));notify('保存結果を確認しました。Blenderは起動していません。');})}>{action==='adopt'?'保存結果を検証して採用':'採用せずに解消'}</button>)}</div>)}
    <p>素材の追加・Asset Browser・ポーズの選択は、接続したBlenderの画面で行えます。保存済みの撮影と採用履歴は保持しています。再撮影は作業用コピーをGUIで開き、対象コマへ割り当ててください。</p>
  </fieldset>;
}
