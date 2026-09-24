import React, {useEffect,useState} from 'react';
import {call,desktop} from './bridge.js';

export default function TapNowSettings({busy,run}) {
  const [connected,setConnected]=useState(false);
  const [tools,setTools]=useState(null);
  useEffect(()=>{if(desktop()) call('tapnow_status').then(setConnected).catch(()=>{});},[]);
  return <details><summary>TapNow接続（ツール確認）</summary>
    <fieldset disabled={!!busy||!desktop()}>
      <p>TapNowのMacアプリ向け接続を検証します。認証画面を開き、読み取り権限でツール仕様を確認します。画像・動画の生成はまだ使えません。</p>
      {!connected ? <button onClick={()=>run('TapNowの認証を待っています',async()=>{
        await call('tapnow_connect');setConnected(true);setTools(null);
      })}>TapNowに接続</button> : <>
        <button onClick={()=>run('TapNowのツールを確認中',async()=>setTools((await call('tapnow_tools')).tools))}>ツール仕様を確認</button>
        <button onClick={()=>run('TapNowを切断中',async()=>{await call('tapnow_disconnect');setConnected(false);setTools(null);})}>接続を解除</button>
      </>}
      {tools && <><p role="status">{tools.length}件のツールを確認しました。生成操作は実行していません。</p>
        <details><summary>取得した仕様</summary><pre>{JSON.stringify(tools,null,2)}</pre></details></>}
    </fieldset>
  </details>;
}
