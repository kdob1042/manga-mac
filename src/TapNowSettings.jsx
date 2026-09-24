import React, {useEffect,useState} from 'react';
import {call,desktop} from './bridge.js';

export default function TapNowSettings({busy,run}) {
  const [connected,setConnected]=useState(false);
  const [tools,setTools]=useState(null);
  const image=tools?.find(tool=>tool.name==='create_hero_image');
  const video=tools?.find(tool=>tool.name==='create_hero_video');
  const result=tools?.find(tool=>tool.name==='get_production_result');
  useEffect(()=>{if(desktop()) call('tapnow_status').then(setConnected).catch(()=>{});},[]);
  return <details><summary>TapNow接続（ツール確認）</summary>
    <fieldset disabled={!!busy||!desktop()}>
      <p>TapNowのMacアプリ向け接続を検証します。認証画面を開き、ツール一覧を取得できたときだけ接続済みになります。画像・動画の生成はまだ使えません。</p>
      {!connected ? <button onClick={()=>run('TapNowの認証を待っています',async()=>{
        const result=await call('tapnow_connect');setTools(result.tools);setConnected(true);
      })}>TapNowに接続</button> : <>
        <button onClick={()=>run('TapNowのツールを確認中',async()=>setTools((await call('tapnow_tools')).tools))}>ツール仕様を確認</button>
        <button onClick={()=>run('TapNowを切断中',async()=>{await call('tapnow_disconnect');setConnected(false);setTools(null);})}>接続を解除</button>
      </>}
      {tools && <><p role="status">{tools.length}件のツールを確認しました。生成操作は実行していません。</p>
        <ul>
          <li>画像作成: {image ? 'create_hero_image の定義を確認' : '定義を確認できません'}</li>
          <li>動画作成: {video ? 'create_hero_video の定義を確認' : '定義を確認できません'}</li>
          <li>結果照会: {result ? 'get_production_result の定義を確認' : '定義を確認できません'}</li>
        </ul>
        <p>ツール定義の取得はアプリでの生成・復旧を保証しません。費用上限と実応答の確認が済むまで、TapNowへの有料送信は使えません。</p>
        <details><summary>取得した仕様</summary><pre>{JSON.stringify(tools,null,2)}</pre></details></>}
    </fieldset>
  </details>;
}
