import React, { useEffect, useRef, useState } from 'react';
import { call, desktop } from './bridge';
import { imageHash } from './revisions';
import { beginTripoJob, collectTripoJob, submitTripoJob, tripoJobs, updateTripoJob, TRIPO_MODEL } from './tripo';

export default function TripoSettings({ project, current, commit, disabled, run, notify }) {
  const [apiKey, setApiKey] = useState('');
  const [budget, setBudget] = useState(300);
  const [approved, setApproved] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [kind, setKind] = useState('character');
  const [assetName, setAssetName] = useState('');
  const [reference, setReference] = useState(null);
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
  async function chooseReference(file) {
    if (!file) { setReference(null); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 20 * 1024 * 1024) throw Error('20MB以下のPNG/JPEG/WebPを選択してください');
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setReference({ image, hash: await imageHash(image) });
  }
  return <details>
    <summary>参照画像から3Dモデルを作る（Tripo・任意）</summary>
    <fieldset disabled={disabled || !desktop()}>
      <p>既存GLBを優先し、不足する素材はTripo公式APIの画像→3D経路で作れます。モデル版は {TRIPO_MODEL} に固定し、APIキーは作品へ保存しません。</p>
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
      <label>素材の種類<select aria-label="Tripo素材の種類" value={kind} onChange={e => setKind(e.target.value)}><option value="character">人物</option><option value="environment">背景</option><option value="prop">小物</option></select></label>
      {kind === 'character'
        ? <label>生成する人物<select aria-label="Tripo生成対象" value={characterId} onChange={e => setCharacterId(e.target.value)}><option value="">人物を選択</option>{(project.characters ?? []).map(c => <option key={c.id} value={c.id}>{c.name} · v{c.version ?? '?'}</option>)}</select></label>
        : <><label>素材名<input aria-label="Tripo素材名" value={assetName} maxLength={100} onChange={e => setAssetName(e.target.value)} placeholder="体育館のゴール" /></label>
          <label>素材の参照画像<input aria-label="Tripo素材の参照画像" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => run('素材画像を読み込み', () => chooseReference(e.target.files?.[0]))} /></label></>}
      <label>モデル作成の補足指示<textarea aria-label="Tripo生成指示" maxLength={1000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="全身、衣装の形状を保持。漫画用の人物モデル。" /></label>
      <button disabled={!connectionId || (kind === 'character' ? !characterId : !reference || !assetName.trim())} onClick={() => run('Tripoへ参照画像を送信', async () => {
        const started = beginTripoJob(current.current, kind === 'character' ? { characterId, prompt } : { kind, name: assetName, reference, prompt });
        const jobId = started.jobs.at(-1).id;
        await commit(started);
        await submitTripoJob(started, jobId, connectionId).then(commit);
        setSelectedJob(jobId); setArtifact(null);
        notify('Tripoへ1件だけ送信しました。状態を確認するまで再送しません。');
      })}>参照画像からモデルを生成</button>
      {jobs.map(item => <article key={item.id}>
        <label><input type="radio" name="tripo-job" checked={selectedJob === item.id} onChange={() => { setSelectedJob(item.id); setArtifact(null); }} />{item.manifest?.source?.character_id ?? item.manifest?.source?.asset_name} · {item.remote?.status ?? item.status} · {item.remote?.task_id ?? '未送信'}</label>
      </article>)}
      {job && <div>
        <button disabled={!connectionId || !job.remote?.task_id} onClick={() => run('Tripoの状態を照会', async () => updateTripoJob(current.current, job.id, connectionId).then(commit))}>状態を更新</button>
        <button disabled={!connectionId || job.remote?.status !== 'success'} onClick={() => run('Tripoモデルを取得・検証', async () => {
          const result = await collectTripoJob(current.current, job.id, connectionId);
          setArtifact(result.artifact); await commit(result.project); notify('検証済みGLBを3D素材一覧へ登録しました。');
        })}>生成済みGLBを取得</button>
        {selectedArtifact && <p>素材: {selectedArtifact.file} ／ SHA-256 {selectedArtifact.hash?.slice(0, 16)}…</p>}
      </div>}
    </fieldset>
  </details>;
}
