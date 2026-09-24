import React, {useState} from 'react';

export default function SourceConnectionNotice({failure, busy, onRetry, onSettings, onSelection}) {
  const [copyState,setCopyState]=useState('');
  if (!failure) return null;
  const {summary,next,action,diagnostic}=failure;
  async function copy() {
    try { await navigator.clipboard.writeText(diagnostic); setCopyState('診断をコピーしました'); }
    catch { setCopyState('コピーできません。下の診断を選択してコピーしてください'); }
  }
  return <section className="message error" role="alert" aria-label="原稿接続の診断">
    <strong>{summary}</strong><p>{next}</p>
    {action==='settings'&&<button disabled={busy} onClick={onSettings}>読取り用トークンを確認</button>}
    {action==='settings'&&<button disabled={busy} onClick={onRetry}>同じ操作を再試行</button>}
    {action==='selection'&&<button disabled={busy} onClick={onSelection}>作品・話を確認</button>}
    {action==='retry'&&<button disabled={busy} onClick={onRetry}>同じ操作を再試行</button>}
    <details><summary>技術的な詳細と診断</summary><pre>{diagnostic}</pre><button onClick={copy}>診断をコピー</button>{copyState&&<small role="status">{copyState}</small>}</details>
  </section>;
}
