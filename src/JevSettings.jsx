import React, { useState } from 'react';
import { registerConnection, releaseConnection } from './llm';
export default function JevSettings({ value, onChange, run, busy }) {
  const [key,setKey]=useState(''),[approved,setApproved]=useState(false);
  return <fieldset disabled={busy}><legend>操作の判断（任意：Jev）</legend><small>api.typesafe.aiへ修正指示・表示コマのIDと対応操作を送信します。画像・原作本文は送りません。利用料金が発生します。</small>
    <label>Jev APIキー<input aria-label="Jev APIキー" type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)}/></label>
    <label><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>この送信先と判断用途を許可する</label>
    <button disabled={!approved || !key.trim()} onClick={()=>run('Jevを登録中',async()=>{const next=await registerConnection({provider:'jev',purpose:'classify',baseUrl:'https://api.typesafe.ai',model:'jev-latest',apiKey:key,jsonMode:true});await releaseConnection(value?.connectionId);onChange(next);setKey('');})}>Jevを登録</button>
    {value?.connectionId && <button onClick={()=>run('Jevを解除',async()=>{await releaseConnection(value.connectionId);onChange(null);})}>Jevを解除</button>}
    <small>{value?.connectionId?'判断用途を登録済み（実API応答は未確認）':'未設定。自然言語編集は選択済みの演出LLMを使います。手動編集は通信しません。'}</small>
  </fieldset>;
}
