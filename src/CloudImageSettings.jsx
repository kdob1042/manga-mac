import React, {useEffect, useState} from 'react';
import {call, desktop} from './bridge.js';
import {imageModel, mediaProvider, imageConnectionId} from './media.js';

export default function CloudImageSettings({modelId, current, commit, run, busy}) {
  const selected = imageModel(modelId), provider = mediaProvider(selected);
  const dollars = selected.cost?.unit === 'milliUSD';
  const [key, setKey] = useState(''), [limit, setLimit] = useState(50);
  const [approved, setApproved] = useState(false), [registered, setRegistered] = useState(false);
  useEffect(() => {
    let active = true;
    setKey(''); setApproved(false); setRegistered(false); setLimit(dollars ? 1 : 50);
    const id = imageConnectionId(current.current, modelId);
    // A local memory lookup, never an authentication probe or paid test.
    if (desktop() && id) call('media_connection_registered', {connectionId:id, modelId})
      .then(value => { if (active) setRegistered(value); }).catch(() => {});
    return () => { active = false; };
  }, [modelId]);
  if (!selected.requires_connection) return null;
  const amount = selected.cost.amount, unit = dollars ? 'USD' : 'credits';
  const budget = Math.round(limit * (dollars ? 1000 : 1));
  const save = id => commit({...current.current, mediaDefaults: {...current.current.mediaDefaults,
    imageConnections: {...current.current.mediaDefaults?.imageConnections, [modelId]:id}}});
  return <fieldset disabled={busy || !desktop()}>
    <legend>{provider.display_name}静止画の接続</legend>
    <p>{selected.cost.reservation_only ? `1回${amount/1000} USDを予算枠から仮予約します。実費は入力画像と生成量に応じた従量料金です。厳密な請求上限ではありません。` : `1枚${amount} ${unit}。`} キーは起動中だけ保持し、作品・バックアップには保存しません。</p>
    {registered ? <>
      <p role="status">キーを登録済み</p>
      <button onClick={() => run('静止画接続を解除', async () => {
        await call('remove_image', {connectionId:imageConnectionId(current.current,modelId)});
        setRegistered(false); setApproved(false); await save('');
      })}>静止画接続を解除</button>
    </> : <>
      <label>静止画APIキー<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)}/></label>
      <label>この作品の静止画{dollars ? '予算枠' : '上限'}（{unit}）<input type="number" min={dollars ? amount/1000 : amount} max={dollars ? 6 : 6000} step={dollars ? .001 : 1} value={limit} onChange={e => setLimit(Number(e.target.value))}/></label>
      <label><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)}/>選択コマの作画指示と対応画像を{provider.display_name}へ送り、この予算枠での生成を許可する</label>
      <button disabled={!approved || !key.trim() || !Number.isInteger(budget) || budget < amount || budget > 6000} onClick={() => run('静止画接続を登録', async () => {
        const previous = imageConnectionId(current.current,modelId);
        const id = await call('register_image', {modelId, input:{credential:key,max_credits:budget,approved}});
        setKey('');
        try { await save(id); }
        catch (error) { await call('remove_image', {connectionId:id}); throw error; }
        setRegistered(true);
        if (previous && previous !== id) await call('remove_image', {connectionId:previous});
      })}>静止画接続を登録</button>
    </>}
  </fieldset>;
}
