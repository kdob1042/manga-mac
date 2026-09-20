import React, { useEffect, useRef, useState } from 'react';
import { call, desktop } from './bridge';
import { directoryWork, handoffLive, liveCall, liveWork } from './live-blender';
import { beginTripoJob, collectTripoJob, submitTripoJob, tripoJobs, updateTripoJob, TRIPO_MODEL } from './tripo';

export default function TripoSettings({ project, current, commit, disabled, run, notify }) {
  const [apiKey, setApiKey] = useState('');
  const [budget, setBudget] = useState(300);
  const [approved, setApproved] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedJob, setSelectedJob] = useState('');
  const [balance, setBalance] = useState(null);
  const [artifact, setArtifact] = useState(null);
  const connectionRef = useRef('');
  useEffect(() => () => {
    if (connectionRef.current) call('remove_tripo', { connectionId: connectionRef.current }).catch(() => {});
  }, []);
  const jobs = tripoJobs(project);
  const job = jobs.find(item => item.id === selectedJob);
  const selectedArtifact = artifact ?? job?.remote?.artifact;
  async function importIntoLive() {
    if (!selectedArtifact?.file || !selectedArtifact?.hash) throw Error('先に検証済みGLBを取得してください');
    const target = current?.current;
    if (!target) throw Error('作品状態を取得できません');
    try {
      await liveCall(call, target, 'status');
    } catch (error) {
      if (!String(error?.message ?? error).includes('live接続がありません')) throw error;
      await call('blender_gui_start', { input: {
        work: liveWork(target), directory_work: directoryWork(target),
        scope: `tripoModel:${job.id}`, template: ''
      }});
    }
    await handoffLive(call, target);
    const observed = await liveCall(call, target, 'observe', { scope: 'summary' });
    const result = await liveCall(call, target, 'import_asset', {
      expected: observed,
      file: selectedArtifact.file,
      hash: selectedArtifact.hash
    });
    notify(`検証済みGLBを同じBlender GUIへ取り込みました（${result.objects?.length ?? 0}オブジェクト）。`);
  }
  return <details>
    <summary>参照画像から3Dモデルを作る（Tripo・任意）</summary>
    <fieldset disabled={disabled || !desktop()}>
      <p>Tripo公式APIの画像→3D経路を使います。モデル版は {TRIPO_MODEL} に固定し、APIキーは作品・blend・制作依頼ZIPへ保存しません。</p>
      <label>Tripo APIキー<input aria-label="Tripo APIキー" type="password" autoComplete="off" disabled={!!connectionId} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="tsk_..." /></label>
      <label>この作品で承認する上限（credits）<input aria-label="Tripo予算" type="number" min="1" max="100000" value={budget} disabled={!!connectionId} onChange={e => setBudget(Number(e.target.value))} /></label>
      <label><input type="checkbox" checked={approved} disabled={!!connectionId} onChange={e => setApproved(e.target.checked)} />この送信先・参照画像・モデル・上限で生成を許可する</label>
      {!connectionId ? <button disabled={!apiKey.trim() || !approved} onClick={() => run('Tripo接続を登録', async () => {
        const id = await call('register_tripo', { input: { credential: apiKey, max_credits: budget, approved } });
        connectionRef.current = id; setConnectionId(id); setApiKey('');
        notify('Tripo接続を登録しました。登録だけでは画像を送信しません。');
      })}>Tripo接続を登録</button> : <>
        <button onClick={() => run('Tripo残高を確認', async () => setBalance(await call('tripo_balance', { connectionId })))}>残高を確認</button>
        <button onClick={() => run('Tripo接続を解除', async () => { await call('remove_tripo', { connectionId }); connectionRef.current = ''; setConnectionId(''); setApproved(false); setBalance(null); })}>接続を解除</button>
      </>}
      {balance && <p>残高 {balance.balance} ／ 凍結 {balance.frozen}</p>}
      <small>再起動後はキーを再入力します。応答不明時は自動再送しません。</small>
      <label>生成する人物<select aria-label="Tripo生成対象" value={characterId} onChange={e => setCharacterId(e.target.value)}><option value="">人物を選択</option>{(project.characters ?? []).map(c => <option key={c.id} value={c.id}>{c.name} · v{c.version ?? '?'}</option>)}</select></label>
      <label>モデル作成の補足指示<textarea aria-label="Tripo生成指示" maxLength={1000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="全身、衣装の形状を保持。漫画用の人物モデル。" /></label>
      <button disabled={!connectionId || !characterId} onClick={() => run('Tripoへ参照画像を送信', async () => {
        const started = beginTripoJob(current.current, { characterId, prompt });
        const jobId = started.jobs.at(-1).id;
        await commit(started);
        await submitTripoJob(started, jobId, connectionId).then(commit);
        setSelectedJob(jobId);
        notify('Tripoへ1件だけ送信しました。状態を確認するまで再送しません。');
      })}>参照画像からモデルを生成</button>
      {jobs.map(item => <article key={item.id}>
        <label><input type="radio" name="tripo-job" checked={selectedJob === item.id} onChange={() => setSelectedJob(item.id)} />{item.manifest?.source?.character_id} · {item.remote?.status ?? item.status} · {item.remote?.task_id ?? '未送信'}</label>
      </article>)}
      {job && <div>
        <button disabled={!connectionId || !job.remote?.task_id} onClick={() => run('Tripoの状態を照会', async () => updateTripoJob(current.current, job.id, connectionId).then(commit))}>状態を更新</button>
        <button disabled={!connectionId || job.remote?.status !== 'success'} onClick={() => run('Tripoモデルを取得・検証', async () => {
          const result = await collectTripoJob(current.current, job.id, connectionId, directoryWork(current.current), 'tripoModel:' + job.id);
          setArtifact(result.artifact); await commit(result.project); notify('検証済みGLBを素材フォルダへ保存しました。Blenderの同じGUIへ明示取込みできます。');
        })}>生成済みGLBを取得</button>
        {selectedArtifact && <><p>素材: {selectedArtifact.file} ／ SHA-256 {selectedArtifact.hash?.slice(0, 16)}…</p><button disabled={!desktop()} onClick={() => run('検証済みGLBをBlenderへ取込み', importIntoLive)}>同じBlender GUIへ取り込む</button></>}
      </div>}
    </fieldset>
  </details>;
}
