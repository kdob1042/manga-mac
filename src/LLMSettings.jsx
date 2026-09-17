import React from 'react';
import { providers, defaultConnection, askLLM, registerConnection, releaseConnection } from './llm';
export default function LLMSettings({ title, value, onChange, disabled, run, notify }) {
  const external = value.provider !== 'ollama';
  const replace = next => { onChange(next); releaseConnection(value.connectionId).catch(() => notify('旧接続の解除に失敗しました。アプリを再起動すると全接続を解除します。')); };
  const change = patch => replace({ ...value, ...patch, connectionId: '', visualEditing:false });
  return <fieldset disabled={disabled} className="llm-settings"><legend>{title}</legend>
    <label>接続先<select aria-label={`${title}の接続先`} value={value.provider} onChange={e => replace(defaultConnection(e.target.value))}>{Object.entries(providers).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}</select></label>
    {value.provider === 'custom' && <label>APIベースURL（HTTPS）<input value={value.baseUrl} onChange={e => change({ baseUrl: e.target.value, apiKey: '' })} placeholder="https://example.com/v1"/></label>}
    <label>モデルID<input aria-label={`${title}のモデルID`} value={value.model} onChange={e => change({ model: e.target.value })} placeholder="利用するモデルID"/></label>
    {external&&<label>同時要求の上限<select aria-label={`${title}の同時要求の上限`} value={value.concurrency??2} onChange={e=>onChange({...value,concurrency:Number(e.target.value)})}><option value={1}>1件ずつ</option><option value={2}>最大2件</option></select><small>接続先の制限に合わせて選択してください。実行中の要求は完了まで継続します。</small></label>}
    {external && <><label>APIキー<input type="password" autoComplete="off" aria-label={`${title}のAPIキー`} value={value.apiKey} onChange={e => change({ apiKey: e.target.value })}/></label><small>送信先：{value.provider === 'custom' ? value.baseUrl || '未設定' : providers[value.provider].baseUrl}<br/>脚本・設定・人物の説明を送信します。 API利用料が発生します。登録後のキーはRust側の起動中メモリだけで保持します。</small>{value.provider === 'custom' && <label><input type="checkbox" checked={value.jsonMode} onChange={e => change({ jsonMode: e.target.checked })}/> JSON出力モード（非対応APIではオフ）</label>}</>}
    {!external && <small>通信先はこのMacのOllamaです。推論がローカルで完結する保証はありません。オフラインで使う場合はOllama側のcloud無効化設定と導入モデルを確認してください。</small>}
    <label><input type="checkbox" checked={!!value.visualEditing} onChange={e=>onChange({...value,visualEditing:e.target.checked})}/>対象認識・文字配置に作画画像をこの接続へ送る</label><small>画像対応モデルが必要です。認識できない場合は停止し、別の接続へは送りません。</small>
    {value.connectionId && <small>接続を登録済み（この起動中のみ）</small>}
    <button type="button" onClick={() => run('LLMの接続を確認中', async () => { const registered = value.connectionId ? value : await registerConnection(value); onChange(registered); const result = JSON.parse(await askLLM(registered, { purpose: 'probe', prompt: 'Return {"ok":true}.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })); if (result.ok !== true) throw Error('接続先のJSON応答が不正です'); notify('LLMへの接続とJSON応答を確認しました。'); })}>接続をテスト</button>
  </fieldset>;
}
