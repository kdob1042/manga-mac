import React, { useState, useEffect } from 'react';
import { call, desktop } from './bridge';
export default function BlenderSettings({ disabled, run, notify }) {
  const [binary, setBinary] = useState('/Applications/Blender.app/Contents/MacOS/Blender');
  const [library, setLibrary] = useState(''), [source, setSource] = useState('');
  const [session, setSession] = useState(null), [lens, setLens] = useState(50);
  useEffect(() => { if (desktop()) call('blender_latest').then(setSession).catch(() => notify('Blenderの保存状態を読めませんでした')); }, []);
  const pending = session?.jobs?.some(job => ['unknown', 'running'].includes(job.status));
  const refresh = async () => {
    if (!session) return;
    const current = await call('blender_status', { sessionId: session.session_id });
    setSession(current);
    if (current.state?.state?.lens) setLens(current.state.state.lens);
    return current;
  };
  const recover = (job, action) => run('Blenderの保存結果を確認中', async () => {
    const current = await call('blender_recover', {
      sessionId: session.session_id, requestId: job.id,
      expectedRevision: session.revision, action,
    });
    setSession(current);
    if (current.state?.state?.lens) setLens(current.state.state.lens);
    notify(action === 'adopt' ? '検証した保存結果を採用しました。Blenderは再実行していません。' :
      '現在の採用版を保持し、この要求を採用せずに解消しました。成果物は残しています。');
  });
  const operate = operation => run('Blenderで処理中', async () => {
    try {
      const result = await call('blender_execute', { request: { session_id: session.session_id, request_id: crypto.randomUUID(), expected_revision: session.revision, operation } });
      setSession(result); notify('Blenderの実値と保存結果を確認しました');
    } catch (error) {
      await refresh().catch(() => notify('要求状態を取得できませんでした。状態確認を再度行ってください。'));
      throw error;
    }
  });
  return <fieldset disabled={disabled}><legend>Blender 4.5.13</legend>
    <label>Blender実行ファイル<input value={binary} onChange={e => setBinary(e.target.value)}/></label>
    <label>読み込みを許可する素材フォルダ<input value={library} onChange={e => setLibrary(e.target.value)} placeholder="/Users/名前/BlenderAssets"/></label>
    <label>開くblendファイル<input value={source} onChange={e => setSource(e.target.value)} placeholder="素材フォルダ内のファイル.blend"/></label>
    <small>専用のバックグラウンド処理で開きます。元のblendと、開いているBlenderの画面は変更しません。撮影画像はまだ漫画化へ接続されていません。</small>
    <button onClick={() => run('Blenderの接続を確認中', async () => {
      const created = await call('blender_register', { input: { binary, library_root: library, source } });
      setSession(created);
      try {
        const result = await call('blender_execute', { request: { session_id: created.session_id, request_id: crypto.randomUUID(), expected_revision: 0, operation: { kind: 'inspect' } } });
        setSession(result); setLens(result.state.state.lens); notify('Blenderの版・カメラ・描画設定を確認しました');
      } catch (error) {
        await call('blender_status', { sessionId: created.session_id }).then(setSession)
          .catch(() => notify('要求状態を取得できませんでした。状態確認を再度行ってください。'));
        throw error;
      }
    })}>開いて接続を確認</button>
    {session && <>
      <p>接続版：{session.revision} ／ 焦点距離：{session.state?.state?.lens ?? '未確認'} mm</p>
      <label>焦点距離（mm）<input type="number" min="10" max="250" value={lens} onChange={e => setLens(Number(e.target.value))}/></label>
      <button disabled={pending} onClick={() => operate({ kind: 'camera', lens })}>カメラを変更</button>
      <button disabled={pending} onClick={() => operate({ kind: 'capture', width: 768, height: 768 })}>撮影する</button>
      <button onClick={() => run('Blenderの状態を確認中', async () => {
        const current = await refresh();
        notify(current.jobs.some(j => ['unknown', 'running'].includes(j.status)) ? '未確定の要求があります。自動再送は停止しています。' : '保存された接続版と要求状態を確認しました');
      })}>要求状態を確認</button>
      {session.jobs?.filter(job => ['unknown', 'running', 'candidate'].includes(job.status)).map(job => <div key={job.id}>
        <p>要求 {job.id.slice(0, 8)}：{job.status === 'running' ? '処理中' : job.status === 'candidate' ? '旧版の候補' : '結果未確定'}</p>
        <button disabled={job.status === 'running' || job.expected_revision !== session.revision} onClick={() => recover(job, 'adopt')}>保存結果を検証して採用</button>
        <button disabled={job.status === 'running'} onClick={() => recover(job, 'abandon')}>採用せずに解消</button>
      </div>)}
      {session.preview && <img src={session.preview} alt="Blenderで実際に撮影した画像" style={{ maxWidth: '100%' }}/>} 
    </>}
  </fieldset>;
}
