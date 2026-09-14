import React, { useState, useEffect } from 'react';
import { call, desktop } from './bridge';
export default function BlenderSettings({ disabled, run, notify }) {
  const [binary, setBinary] = useState('/Applications/Blender.app/Contents/MacOS/Blender');
  const [library, setLibrary] = useState(''), [source, setSource] = useState('');
  const [session, setSession] = useState(null), [lens, setLens] = useState(50);
  useEffect(() => { if (desktop()) call('blender_latest').then(setSession).catch(() => notify('Blenderの保存状態を読めませんでした')); }, []);
  const operate = operation => run('Blenderで処理中', async () => {
    const result = await call('blender_execute', { request: { session_id: session.session_id, request_id: crypto.randomUUID(), expected_revision: session.revision, operation } });
    setSession(result); notify('Blenderの実値と保存結果を確認しました');
  });
  return <fieldset disabled={disabled}><legend>Blender 4.5.13</legend>
    <label>Blender実行ファイル<input value={binary} onChange={e => setBinary(e.target.value)}/></label>
    <label>読み込みを許可する素材フォルダ<input value={library} onChange={e => setLibrary(e.target.value)} placeholder="/Users/名前/BlenderAssets"/></label>
    <label>開くblendファイル<input value={source} onChange={e => setSource(e.target.value)} placeholder="素材フォルダ内のファイル.blend"/></label>
    <small>専用のバックグラウンド処理で開きます。元のblendと、開いているBlenderの画面は変更しません。撮影画像はまだ漫画化へ接続されていません。</small>
    <button onClick={() => run('Blenderの接続を確認中', async () => {
      const created = await call('blender_register', { input: { binary, library_root: library, source } });
      setSession(created);
      const result = await call('blender_execute', { request: { session_id: created.session_id, request_id: crypto.randomUUID(), expected_revision: 0, operation: { kind: 'inspect' } } });
      setSession(result); setLens(result.state.state.lens); notify('Blenderの版・カメラ・描画設定を確認しました');
    })}>開いて接続を確認</button>
    {session && <>
      <p>接続版：{session.revision} ／ 焦点距離：{session.state?.state?.lens ?? '未確認'} mm</p>
      <label>焦点距離（mm）<input type="number" min="10" max="250" value={lens} onChange={e => setLens(Number(e.target.value))}/></label>
      <button onClick={() => operate({ kind: 'camera', lens })}>カメラを変更</button>
      <button onClick={() => operate({ kind: 'capture', width: 768, height: 768 })}>撮影する</button>
      <button onClick={() => run('Blenderの状態を確認中', async () => {
        const current = await call('blender_status', { sessionId: session.session_id }); setSession({ ...session, ...current });
        notify(current.jobs.some(j => ['unknown', 'running'].includes(j.status)) ? '未確定の要求があります。自動再送は停止しています。' : '保存された接続版と要求状態を確認しました');
      })}>要求状態を確認</button>
      {session.preview && <img src={session.preview} alt="Blenderで実際に撮影した画像" style={{ maxWidth: '100%' }}/>} 
    </>}
  </fieldset>;
}
