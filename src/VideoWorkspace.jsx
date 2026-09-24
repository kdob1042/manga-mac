import React, { useState, useEffect, useRef, useMemo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { call, desktop, loadProject } from './bridge';
import { sourceUnits, sourceForPanel } from './core';
import { createVideoShot, adoptVideoCandidate, undoVideo, beginVideoJob, validateVideoShot, videoConnectionSupportsEndFrame } from './video';
import { adjacentPanelPairs, createSelectedAdjacentVideoShots } from './video-transition';
import { videoStatusLabel, resolveVideoTask } from './video-remote';
import { draftVideoMotion } from './video-plan';
import { defaultVideoModelId, videoModels, videoModel, videoConnection, videoEstimateCredits, validateVideoModelRequest } from './media.js';
import { executeVideo } from './media-runtime.js';
import { createPanelVideoShots, panelVideoRecipe, savedVideoBatches, runVideoBatch } from './video-batch.js';

const loadCapture = (sessionId, requestId) => call('legacy_capture_read', { sessionId, requestId });
export default function VideoWorkspace({ project, current, commit, run, busy, notify, model, requestedShot, requestedPairId, onPairConsumed, requestedPanelIds = [], onPanelsConsumed }) {
  const snapshot = project.snapshots.find(s => s.id === project.active);
  const [sceneId, setSceneId] = useState(''), [imageId, setImageId] = useState(''), [prompt, setPrompt] = useState(''), [selected, setSelected] = useState('');
  useEffect(() => { if (requestedShot) { setSelected(requestedShot); setPlayback(null); } }, [requestedShot]);
  const [playback, setPlayback] = useState(null), [playError, setPlayError] = useState('');
  const [ratio, setRatio] = useState('960:960'), [editRatio, setEditRatio] = useState('960:960');
  const [duration, setDuration] = useState(5), [editDuration, setEditDuration] = useState(5);
  const [apiKey, setApiKey] = useState(''), [budget, setBudget] = useState(180), [approved, setApproved] = useState(false), [videoConnections, setVideoConnections] = useState({}), [videoModelId, setVideoModelId] = useState(project.mediaDefaults?.video ?? defaultVideoModelId), [acceptDeletion, setAcceptDeletion] = useState(false), [editPrompt, setEditPrompt] = useState('');
  const [localExecutable, setLocalExecutable] = useState(''), [localModelDir, setLocalModelDir] = useState(''), [localFfmpeg, setLocalFfmpeg] = useState('');
  const [transitionPairIds, setTransitionPairIds] = useState([]), [transitionPrompt, setTransitionPrompt] = useState(''), [transitionRatio, setTransitionRatio] = useState('960:960'), [transitionDuration, setTransitionDuration] = useState(5);
  const [batchPanelIds, setBatchPanelIds] = useState([]), [batchPrompt, setBatchPrompt] = useState(''), [batchRatio, setBatchRatio] = useState('960:960'), [batchDuration, setBatchDuration] = useState(5);
  const [batchRows, setBatchRows] = useState({}), [batchId, setBatchId] = useState(''), [batchApproval, setBatchApproval] = useState('');
  const [savedBatchDraft, setSavedBatchDraft] = useState('');
  const [batchRunning, setBatchRunning] = useState(false), [batchStopping, setBatchStopping] = useState(false);
  const batchStop = useRef(false), batchLock = useRef(false), batchSource = useRef(project.active);
  const pairOptions = useMemo(() => adjacentPanelPairs(project), [project]), pairOptionKey = pairOptions.map(pair => pair.id + ':' + pair.valid).join('|');
  useEffect(() => {
    const available = new Set(pairOptions.filter(pair => pair.valid).map(pair => pair.id));
    setTransitionPairIds(ids => ids.filter(id => available.has(id)));
  }, [pairOptionKey]);
  useEffect(() => {
    if (requestedPairId && pairOptions.some(pair => pair.id === requestedPairId && pair.valid)) {
      setTransitionPairIds(ids => ids.includes(requestedPairId) ? ids : [...ids, requestedPairId]);
    }
  }, [requestedPairId, pairOptionKey]);
  useEffect(() => {
    if (!requestedPanelIds.length) return;
    const ids = [...new Set(requestedPanelIds)];
    setBatchPanelIds(ids);
    setBatchRows(Object.fromEntries(ids.map(panelId => [panelId, { enabled: true }])));
    setSavedBatchDraft(''); setBatchApproval('');
  }, [requestedPanelIds.join('|')]);
  useEffect(() => {
    if (batchSource.current === project.active) return;
    batchSource.current = project.active;
    setBatchPanelIds([]); setBatchRows({}); setBatchId(''); setBatchApproval(''); setSavedBatchDraft('');
  }, [project.active]);
  const batches = useMemo(() => savedVideoBatches(project), [project.videoShots, project.jobs, project.active]);
  const savedBatch = batches.find(item => item.id === batchId) ?? batches.at(-1);
  const pendingBatch = savedBatch?.shots.filter(item => !item.job) ?? [];
  const [checkedTask, setCheckedTask] = useState('');
  const connectionRefs = useRef(new Map());
  const selectedVideoModel = videoModel(videoModelId);
  const localVideo = selectedVideoModel.locality === 'local';
  const videoRatios = selectedVideoModel.input.ratios;
  const videoDurations = useMemo(() => selectedVideoModel.input.durations_sec ?? [selectedVideoModel.input.duration_sec], [selectedVideoModel]);
  const connectionId = videoConnections[videoModelId] ?? '';
  const reusableConnectionId = Object.entries(videoConnections).find(([modelId, id]) =>
    id && videoModel(modelId).provider === selectedVideoModel.provider && videoModel(modelId).adapter_id === selectedVideoModel.adapter_id)?.[1] ?? '';
  const estimate = (seconds, outputRatio) => {
    try { return videoEstimateCredits(videoModelId, seconds, outputRatio); } catch { return null; }
  };
  const draftEstimate = estimate(duration, ratio);
  const requestError = (seconds, outputRatio, text, endFrame = false) => {
    try {
      validateVideoModelRequest(videoModelId, { duration: seconds, ratio: outputRatio, prompt: text || 'x', endFrame });
      return '';
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  useEffect(() => { setVideoModelId(project.mediaDefaults?.video ?? defaultVideoModelId); }, [project.mediaDefaults?.video]);
  useEffect(() => {
    const defaultDuration = selectedVideoModel.input.default_duration_sec ?? videoDurations[0];
    for (const update of [setDuration, setBatchDuration, setTransitionDuration]) update(value => videoDurations.includes(value) ? value : defaultDuration);
    for (const update of [setRatio, setBatchRatio, setTransitionRatio]) update(value => videoRatios.includes(value) ? value : videoRatios[0]);
    setBatchApproval('');
  }, [selectedVideoModel, videoDurations, videoRatios]);
  useEffect(() => () => {
    batchStop.current = true;
    for (const [id, command] of connectionRefs.current) call(command, { connectionId: id }).catch(() => {});
  }, []);
  const images = useMemo(() => [...project.artworks.map(a => ({ key: `artwork|${a.id}`, kind: 'artwork', id: a.id, hash: a.hash, label: `作画 ${a.panel.sceneId} / ${a.id.slice(-8)}` })),
    ...(project.captures ?? []).map(c => ({ key: `capture|${c.id}`, kind: 'capture', id: c.id, hash: c.image.hash, label: `撮影 ${c.id.slice(-8)}` }))], [project.artworks, project.captures]);
  const shot = project.videoShots.find(s => s.id === selected);
  const currentEstimate = shot ? estimate(shot.duration, shot.ratio) : draftEstimate;
  const estimateDuration = shot?.duration ?? duration;
  const activeConnection = connectionId ? videoConnection(videoModelId, connectionId) : null;
  const batchFingerprint = JSON.stringify({ batch: savedBatch?.id, model: videoModelId, connectionId, shots: savedBatch?.shots });
  const batchApproved = batchApproval === batchFingerprint;
  const batchRequestError = pendingBatch.map(({ shot }) => requestError(shot.duration, shot.ratio, shot.prompt, !!shot.transition)).find(Boolean);
  useEffect(() => { setBatchApproval(''); }, [batchFingerprint]);
  const transitionSupported = !shot?.transition || videoConnectionSupportsEndFrame(activeConnection);
  const shotRequestError = shot ? requestError(shot.duration, shot.ratio, shot.prompt, !!shot.transition) : '';
  const shotEdited = !!shot && (editPrompt !== shot.prompt || editRatio !== shot.ratio || editDuration !== shot.duration);
  const editedPendingBatch = shotEdited && pendingBatch.some(item => item.shot.id === selected);
  const batchItems = useMemo(() => batchPanelIds.map(panelId => {
    const row = { panelId, enabled: true, prompt: batchPrompt, duration: batchDuration, ratio: batchRatio, ...batchRows[panelId] };
    return { row, recipe: panelVideoRecipe(project, panelId, row.ratio) };
  }), [project, batchPanelIds, batchRows, batchPrompt, batchDuration, batchRatio]);
  const batchDraftFingerprint = JSON.stringify({ model: videoModelId, items: batchItems.map(({ row, recipe }) => ({ row, artwork: recipe.artwork?.id, hash: recipe.artwork?.hash, snapshot: recipe.panel?.snapshotId })) });
  const enabledBatchItems = batchItems.filter(item => item.row.enabled);
  const canSaveBatch = batchDraftFingerprint !== savedBatchDraft && enabledBatchItems.length > 0 && enabledBatchItems.every(({ row, recipe }) => recipe.valid && row.prompt.trim() && !requestError(row.duration, row.ratio, row.prompt));
  useEffect(() => { setEditPrompt(shot?.prompt ?? ''); setEditRatio(shot?.ratio ?? '960:960'); setEditDuration(shot?.duration ?? selectedVideoModel.input.default_duration_sec ?? videoDurations[0]); setAcceptDeletion(false); setCheckedTask(''); }, [selected, shot?.prompt, shot?.ratio, shot?.duration, selectedVideoModel.input.default_duration_sec, videoDurations]);
  async function refresh() {
    const latest = await loadProject();
    if (!latest) throw Error('作品を再読込できません');
    await commit(latest);
  }
  async function generate() {
    const connection = activeConnection;
    const started = await beginVideoJob(current.current, shot.id, connection, loadCapture);
    await commit(started.project);
    try { await executeVideo('submit', videoModelId, connectionId, { jobId: started.job.id }); }
    finally { await refresh(); }
    notify(localVideo ? 'ローカル動画の結果を保存しました。候補を確認して採用してください。' : '動画要求を送信しました。「状態を更新」で確認できます。自動で生成を再送しません。');
  }
  function updateBatchRow(panelId, patch) {
    setBatchRows(rows => ({ ...rows, [panelId]: { ...rows[panelId], ...patch } }));
    setBatchApproval('');
  }
  async function saveBatchRecipes() {
    const rows = batchItems.map(({ row }) => row);
    const created = createPanelVideoShots(current.current, rows, { duration: batchDuration, ratio: batchRatio });
    await commit(created.project);
    setBatchId(created.batchId); setBatchApproval(''); setSavedBatchDraft(batchDraftFingerprint);
    setSelected(created.shotIds[0]); setPlayback(null);
    onPanelsConsumed?.();
    notify(`${created.shotIds.length}コマの動画レシピを保存しました。内容と費用を確認してからバッチ実行してください。`);
  }
  async function generateBatch() {
    if (editedPendingBatch) throw Error('このバッチに含まれるショットの変更を保存してください。');
    if (batchLock.current || !activeConnection || !batchApproved) throw Error('動画接続とバッチ実行の確認が必要です');
    batchLock.current = true; batchStop.current = false;
    setBatchApproval(''); setBatchRunning(true); setBatchStopping(false);
    try {
      const result = await runVideoBatch({ batchId: savedBatch.id, connection: activeConnection,
        getProject: () => current.current, commit, refresh, loadCapture,
        submit: job => executeVideo('submit', videoModelId, connectionId, { jobId: job.id }),
        shouldStop: () => batchStop.current,
        onProgress: (count, total) => notify(`${count}/${total}件を送信しました。`),
      });
      notify(result.stopped ? `${result.submitted}件送信後に停止しました。残りは未送信です。` : `${result.submitted}件の動画要求を逐次送信しました。結果はコマごとに確認・採用してください。`);
    } finally { batchLock.current = false; setBatchRunning(false); setBatchStopping(false); }
  }
  const jobConnectionId = job => {
    const saved = videoModels.find(item => item.provider === job?.manifest?.connection?.provider && item.model_id === job?.manifest?.connection?.model);
    return saved ? (videoConnections[saved.id] ?? '') : '';
  };
  async function task(jobId, action) {
    const job = current.current.jobs.find(item => item.id === jobId);
    const saved = videoModels.find(item => item.provider === job?.manifest?.connection?.provider && item.model_id === job?.manifest?.connection?.model);
    const savedConnectionId = saved ? videoConnections[saved.id] : '';
    if (!saved || !savedConnectionId) throw Error('生成時と同じ動画モデルの接続を追加してから状態を確認してください');
    try { await executeVideo('task', saved.id, savedConnectionId, { jobId, action, acceptRemoteDeletion: acceptDeletion }); }
    finally { await refresh(); }
  }
  async function verify(artifact) {
    const revision = current.current.videoRevisions.find(v => v.artifact.hash === artifact.hash && v.artifact.size === artifact.size);
    if (!revision) throw Error('保存された動画版がありません');
    const response = await call('video_playback', { revisionId: revision.id });
    if (response.artifact.hash !== artifact.hash || response.artifact.size !== artifact.size) throw Error('動画版が一致しません');
    return response;
  }
  async function play(revision) {
    setPlayback(null); setPlayError('');
    const response = await verify(revision.artifact);
    setPlayback({ revision: revision.id, src: convertFileSrc(response.path) });
  }
  return <section className="video-workspace" aria-label="動画制作">
    {batchRunning && <button disabled={batchStopping} onClick={() => { batchStop.current = true; setBatchStopping(true); }}>次のコマから停止</button>}
    <h2>動画ショット</h2><p>動きを決める → 生成 → 再生して採用</p>
    <details><summary>動画API接続</summary><fieldset disabled={busy || !desktop()}>
      <label>動画の生成先<select aria-label="動画の生成先" value={videoModelId} onChange={e => run('動画モデルを選択', async () => { const next = e.target.value; setVideoModelId(next); setApproved(false); setBatchApproval(''); const descriptor = videoModel(next); const nextRatio = descriptor.input.ratios[0], nextDuration = descriptor.input.default_duration_sec ?? descriptor.input.durations_sec[0]; setRatio(nextRatio); setDuration(nextDuration); setBatchRatio(nextRatio); setBatchDuration(nextDuration); await commit({ ...current.current, mediaDefaults: { ...current.current.mediaDefaults, video: next } }); })}>{videoModels.map(item => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
      <p>{selectedVideoModel.display_name} · 選択した接続の対応機能・入力条件を送信前に検証します。A→Bは終端画像対応の接続だけで実行します。</p>
      {localVideo ? <>
        <p>このMacの取得済みLTXモデルで生成します。モデルの自動取得・外部APIへの切替は行いません。</p>
        <label>LTX実行ファイル<input aria-label="LTX実行ファイル" disabled={!!connectionId} value={localExecutable} onChange={e => { setLocalExecutable(e.target.value); setApproved(false); }}/></label>
        <label>LTXモデルフォルダ<input aria-label="LTXモデルフォルダ" disabled={!!connectionId} value={localModelDir} onChange={e => { setLocalModelDir(e.target.value); setApproved(false); }}/></label>
        <label>FFmpeg実行ファイル<input aria-label="FFmpeg実行ファイル" disabled={!!connectionId} value={localFfmpeg} onChange={e => { setLocalFfmpeg(e.target.value); setApproved(false); }}/></label>
        <label><input type="checkbox" disabled={!!connectionId} checked={approved} onChange={e => setApproved(e.target.checked)}/>ローカルモデルの利用条件を確認し、動画生成を許可する</label>
        {!connectionId ? <button disabled={!approved || !localExecutable.trim() || !localModelDir.trim() || !localFfmpeg.trim()} onClick={() => run('ローカル動画接続を登録', async () => {
          const id = await call('register_local_video', { input: { executable: localExecutable, model_dir: localModelDir, ffmpeg: localFfmpeg, approved } });
          connectionRefs.current.set(id, 'remove_local_video'); setVideoConnections(items => ({ ...items, [videoModelId]: id }));
          notify('ローカル動画接続を登録しました。');
        })}>ローカル接続を登録する</button> : <button onClick={() => run('ローカル動画接続を解除', async () => {
          await call('remove_local_video', { connectionId }); connectionRefs.current.delete(connectionId); setVideoConnections(items => { const next = { ...items }; delete next[videoModelId]; return next; }); setApproved(false);
        })}>接続を解除する</button>}
      </> : <>
      <small>{currentEstimate ? `${currentEstimate.tier} · ${currentEstimate.rate} credits/秒 · ${estimateDuration}秒で${currentEstimate.credits} credits${currentEstimate.minimum ? `（最低${currentEstimate.minimum}）` : ''}` : '現在の尺・寸法は選択モデルに非対応'}（{selectedVideoModel.pricing?.checked_at ?? '料金確認日不明'}確認）。予約額は実請求額とは別です。</small>
      <label>{selectedVideoModel.display_name} APIキー<input aria-label="Runway APIキー" type="password" autoComplete="off" disabled={!!connectionId} value={apiKey} onChange={e => setApiKey(e.target.value)}/></label>
      <label>作品の上限（credits）<input aria-label="作品の上限（credits）" type="number" min={1} max="6000" step="1" disabled={!!connectionId} value={budget} onChange={e => setBudget(Number(e.target.value))}/></label>
      <label><input type="checkbox" disabled={!!connectionId} checked={approved} onChange={e => setApproved(e.target.checked)}/>この送信先・モデル・送信内容・予算内での生成を許可する</label>
      {!connectionId ? <button disabled={!apiKey.trim() || !approved} onClick={() => run('動画接続を登録', async () => {
        const id = await call('register_video', { input: { credential: apiKey, max_credits: budget, approved, provider: selectedVideoModel.provider, model: selectedVideoModel.model_id, adapter_id: selectedVideoModel.adapter_id } });
        connectionRefs.current.set(id, 'remove_video'); setVideoConnections(items => ({ ...items, [videoModelId]: id })); setApiKey('');
        notify('動画接続を登録しました。キーは作品へ保存しません。');
      })}>接続を登録する</button> : <button onClick={() => run('動画接続を解除', async () => { await call('remove_video', { connectionId }); connectionRefs.current.delete(connectionId); setVideoConnections(items => { const next = { ...items }; delete next[videoModelId]; return next; }); setApproved(false); })}>接続を解除する</button>}
      {!connectionId && reusableConnectionId && <button disabled={!approved} onClick={() => run('Runway接続をモデルへ追加', async () => {
        const id = await call('reuse_video_connection', { sourceConnectionId: reusableConnectionId, provider: selectedVideoModel.provider, model: selectedVideoModel.model_id, adapterId: selectedVideoModel.adapter_id, approved });
        connectionRefs.current.set(id, 'remove_video'); setVideoConnections(items => ({ ...items, [videoModelId]: id }));
        notify('同じRunwayキーをこのモデルにも追加しました。');
      })}>同じRunwayキーでこのモデルを追加</button>}
      <small>再起動後は同じRunwayキーを再登録して、保存済みtaskを確認してください。モデルbindingごとに課金送信を明示承認します。</small>
      </>}
    </fieldset></details>
    {!snapshot ? <p>接続・人物設定から原作を取得してください。</p> : <fieldset disabled={busy}>
      <legend>動画を準備</legend>
      <details open={!selected && !batchPanelIds.length && !transitionPairIds.length}><summary>画像から新しいショットを追加</summary>
      <label>原作の場面<select aria-label="原作の場面" value={sceneId} onChange={e => setSceneId(e.target.value)}><option value="">場面を選択</option>{snapshot.scenes.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
      <label>開始画像<select aria-label="開始画像" value={imageId} onChange={e => setImageId(e.target.value)}><option value="">保存済みの画像を選択</option>{images.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></label>
      <label>動きの指示<textarea aria-label="動きの指示" value={prompt} maxLength={selectedVideoModel.input.max_prompt_utf16} onChange={e => setPrompt(e.target.value)} placeholder="カメラがゆっくり寄る。人物は小さくうなずく。"/></label>
      <label>動画の寸法<select aria-label="動画の寸法" value={ratio} onChange={e => setRatio(e.target.value)}>{videoRatios.map(r => <option key={r}>{r}</option>)}</select></label>
      <label>動画の尺<select aria-label="動画の尺" value={duration} onChange={e => setDuration(Number(e.target.value))}>{videoDurations.map(seconds => <option key={seconds} value={seconds}>{seconds}秒</option>)}</select></label>
      <small>PNGの開始画像と同じ縦横比を選んでください。比率が違う画像の自動切り抜きは拒否します。</small>
      {requestError(duration, ratio, prompt || 'x') && <small role="alert">{requestError(duration, ratio, prompt || 'x')}</small>}
      <button disabled={!sceneId || !imageId || !prompt.trim()} onClick={() => run('動画ショットを保存', async () => {
        const p = current.current, scene = snapshot.scenes.find(s => s.id === sceneId), image = images.find(a => a.key === imageId);
        if (!scene || !image) throw Error('場面・画像を選び直してください');
        const artwork = p.artworks.find(a => a.id === image.id);
        const captured = p.captures?.find(c => c.id === image.id);
        const characterIds = [...new Set(artwork?.panel.characterIds ?? captured?.character_ids ?? captured?.character_bindings?.map(b => b.character_id) ?? [])];
        const next = createVideoShot(p, { snapshotId: snapshot.id, sceneId, unitIds: sourceUnits(sceneId, scene.text).map(u => u.id), characterIds,
          startImage: { kind: image.kind, id: image.id, hash: image.hash }, prompt, duration, ratio });
        await commit(next); setSelected(next.videoShots.at(-1).id); setPlayback(null);
      })}>ショットを保存</button>
      <small>選択した場面の原文全体を参照します。台詞音声は生成しません。</small>
      </details>
      <details open={batchPanelIds.length > 0}>
        <summary>選択コマの動画レシピ・バッチ生成</summary>
        <p>共通設定を各コマへ反映します。必要なコマだけ個別に変更できます。保存後に費用を確認して生成します。</p>
        {!batchPanelIds.length && <p>漫画画面でコマを選び、「選択コマを動画化」を押してください。</p>}
        {!!batchPanelIds.length && <>
          <label>共通の動き<textarea aria-label="共通の動き" maxLength={selectedVideoModel.input.max_prompt_utf16} value={batchPrompt} onChange={e => { setBatchPrompt(e.target.value); setSavedBatchDraft(''); setBatchApproval(''); }} placeholder="控えめで自然な動き。カメラがゆっくり寄る。"/></label>
          <label>共通の寸法<select aria-label="共通の動画寸法" value={batchRatio} onChange={e => { setBatchRatio(e.target.value); setSavedBatchDraft(''); setBatchApproval(''); }}>{videoRatios.map(value => <option key={value}>{value}</option>)}</select></label>
          <label>共通の尺<select aria-label="共通の動画尺" value={batchDuration} onChange={e => { setBatchDuration(Number(e.target.value)); setSavedBatchDraft(''); setBatchApproval(''); }}>{videoDurations.map(seconds => <option key={seconds} value={seconds}>{seconds}秒</option>)}</select></label>
          {batchItems.map(({ row, recipe }) => {
            const overrides = batchRows[recipe.panelId] ?? {};
            return <article className="video-batch-row" key={recipe.panelId}>
              <label><input type="checkbox" checked={row.enabled !== false} onChange={e => updateBatchRow(recipe.panelId, { enabled: e.target.checked })}/>{recipe.panelId}</label>
              {recipe.artwork?.panel?.image && <img className="shot-preview" src={recipe.artwork.panel.image} alt={`${recipe.panelId}の開始画像`}/>}
              <p className="video-source">{recipe.source ?? '原文を確認できません'}</p>
              {!recipe.valid && <p role="alert">{recipe.reason}</p>}
              <label>{recipe.panelId}の動き<textarea aria-label={`${recipe.panelId}の動き`} maxLength={selectedVideoModel.input.max_prompt_utf16} disabled={row.enabled === false} value={row.prompt} onChange={e => updateBatchRow(recipe.panelId, { prompt: e.target.value })}/></label>
              <label>尺<select aria-label={`${recipe.panelId}の尺`} disabled={row.enabled === false} value={row.duration} onChange={e => updateBatchRow(recipe.panelId, { duration: Number(e.target.value) })}>{!videoDurations.includes(row.duration)&&<option value={row.duration} disabled>{row.duration}秒（モデル非対応）</option>}{videoDurations.map(seconds => <option key={seconds} value={seconds}>{seconds}秒</option>)}</select></label>
              <label>寸法<select aria-label={`${recipe.panelId}の寸法`} disabled={row.enabled === false} value={row.ratio} onChange={e => updateBatchRow(recipe.panelId, { ratio: e.target.value })}>{!videoRatios.includes(row.ratio)&&<option value={row.ratio} disabled>{row.ratio}（モデル非対応）</option>}{videoRatios.map(value => <option key={value}>{value}</option>)}</select></label>
              {row.enabled && requestError(row.duration, row.ratio, row.prompt) && <p role="alert">{requestError(row.duration, row.ratio, row.prompt)}</p>}
              {['prompt', 'duration', 'ratio'].some(key => Object.hasOwn(overrides, key)) && <button onClick={() => {
                setBatchRows(rows => ({ ...rows, [recipe.panelId]: { enabled: row.enabled } }));
                setSavedBatchDraft(''); setBatchApproval('');
              }}>共通設定に戻す</button>}
            </article>;
          })}
          <button disabled={!canSaveBatch} onClick={() => run('動画レシピを保存', saveBatchRecipes)}>選択コマの動画レシピを保存</button>
        </>}
      </details>
      {!!batches.length && <section aria-label="動画バッチ実行確認">
        <label>保存済み動画バッチ<select aria-label="保存済み動画バッチ" value={savedBatch.id} onChange={e => { setBatchId(e.target.value); setBatchApproval(''); }}>{batches.map((item, index) => <option key={item.id} value={item.id}>{index + 1} · {item.shots.length}コマ</option>)}</select></label>
        <p>未送信 {pendingBatch.length}件 / 全{savedBatch.shots.length}件 · {selectedVideoModel.display_name} · {selectedVideoModel.locality === 'local' ? 'このMacで実行' : batchRequestError ? '費用を計算できません' : `最大${pendingBatch.reduce((sum, { shot }) => sum + (estimate(shot.duration, shot.ratio)?.credits ?? 0), 0)} credits`}</p>
        {savedBatch.shots.map(({ shot: item, job }) => <p key={item.id}><button onClick={() => { setSelected(item.id); setPlayback(null); }}>{item.sourcePanelId} · {item.duration}秒</button> · {job ? videoStatusLabel(job) : '未送信'}</p>)}
        <small>送信済み・結果不明・失敗した要求は再送しません。各コマを開いて状態や候補を確認できます。再生成は各ショットから明示実行してください。</small>
        {batchRequestError && <p role="alert">{batchRequestError}</p>}
        {editedPendingBatch && <p role="status">このバッチに含まれるショットの変更を保存してください。</p>}
        <label><input type="checkbox" disabled={!pendingBatch.length || !!batchRequestError} checked={batchApproved} onChange={e => setBatchApproval(e.target.checked ? batchFingerprint : '')}/>件数・モデル・費用を確認し、1件ずつ送信する</label>
        <button className="primary" disabled={!desktop() || !activeConnection || !batchApproved || !pendingBatch.length || !!batchRequestError || editedPendingBatch} onClick={() => run('動画バッチを逐次送信中', generateBatch)}>保存したレシピをバッチ実行</button>
      </section>}
      <details open={transitionPairIds.length > 0}>
        <summary>隣接コマ間の動画（A→B・任意選択）</summary>
        <p>同じページで読書順に隣り合うコマだけを対象にします。未選択のままなら何も保存・実行しません。</p>
        <p>{transitionPairIds.length}件選択中</p>
        {!pairOptions.length && <p>選択できる隣接コマがありません。ページに採用済み作画のコマを2つ以上配置してください。</p>}
        {pairOptions.map(pair => <article className="video-transition-option" key={pair.id}>
          <label>
            <input
              type="checkbox"
              aria-label={'隣接コマ ' + pair.fromPanelId + ' から ' + pair.toPanelId}
              disabled={!pair.valid}
              checked={transitionPairIds.includes(pair.id)}
              onChange={event => setTransitionPairIds(ids => event.target.checked ? [...ids, pair.id] : ids.filter(id => id !== pair.id))}
            />
            {pair.fromPanelId} → {pair.toPanelId}
          </label>
          <div className="video-transition-thumbnails">
            {pair.fromImage && <img src={pair.fromImage} alt={'始端 ' + pair.fromPanelId} />}
            {pair.toImage && <img src={pair.toImage} alt={'終端 ' + pair.toPanelId} />}
          </div>
          <small>ページ{pair.pageIndex + 1}・読書順 {pair.fromIndex + 1} → {pair.toIndex + 1}</small>
          <small>A 作画版 {pair.fromArtworkRevisionId ?? 'なし'} / {pair.fromArtworkHash?.slice(0, 12) ?? 'なし'} / {pair.fromDimensions ? pair.fromDimensions.width + '×' + pair.fromDimensions.height : '寸法不明'}</small>
          <small>B 作画版 {pair.toArtworkRevisionId ?? 'なし'} / {pair.toArtworkHash?.slice(0, 12) ?? 'なし'} / {pair.toDimensions ? pair.toDimensions.width + '×' + pair.toDimensions.height : '寸法不明'}</small>
          {!pair.valid && <small role="alert">{pair.reason}</small>}
        </article>)}
        <label>隣接コマ間の動き<textarea aria-label="隣接コマ間の動き" maxLength={selectedVideoModel.input.max_prompt_utf16} value={transitionPrompt} onChange={e => setTransitionPrompt(e.target.value)} placeholder="AからBへゆっくりカメラが移動する。"/></label>
        <label>隣接コマ動画の寸法<select aria-label="隣接コマ動画の寸法" value={transitionRatio} onChange={e => setTransitionRatio(e.target.value)}>{videoRatios.map(r => <option key={r}>{r}</option>)}</select></label>
        <label>隣接コマ動画の尺<select aria-label="隣接コマ動画の尺" value={transitionDuration} onChange={e => setTransitionDuration(Number(e.target.value))}>{videoDurations.map(seconds => <option key={seconds} value={seconds}>{seconds}秒</option>)}</select></label>
        <button
          disabled={!transitionPairIds.length || !transitionPrompt.trim()}
          onClick={() => run('選択した隣接コマを保存', async () => {
            const p = current.current;
            const next = createSelectedAdjacentVideoShots(p, transitionPairIds, { prompt: transitionPrompt, duration: transitionDuration, ratio: transitionRatio });
            if (next === p) { notify('隣接コマは未選択です。何も保存しません。'); return; }
            await commit(next);
            setSelected(next.videoShots.at(-1).id);
            setTransitionPairIds([]);
            setPlayback(null);
            onPairConsumed?.();
          })}
        >選択した隣接コマをショットとして保存</button>
      </details>
    </fieldset>}
    <nav aria-label="動画ショット一覧">{project.videoShots.map((s, i) => <button key={s.id} aria-pressed={selected === s.id} disabled={busy} onClick={() => { setSelected(s.id); setPlayback(null); setPlayError(''); }}>{i + 1} · {s.transition ? s.transition.fromPanelId + '→' + s.transition.toPanelId : s.sceneId}</button>)}</nav>
    {shot && <section>
      <h3>{shot.transition ? shot.transition.fromPanelId + ' → ' + shot.transition.toPanelId : shot.sceneId} · {shot.duration}秒 · 無音</h3>
      <p className="video-source">{sourceForPanel(shot, project.snapshots.find(s => s.id === shot.snapshotId))}</p>
      <p>{shot.prompt}</p><small>開始画像 {shot.startImage.hash.slice(0, 12)}{shot.endImage ? ' · 終端画像 ' + shot.endImage.hash.slice(0, 12) : ''} · {shot.ratio}</small>
      <label>このショットの動き<textarea aria-label="このショットの動き" value={editPrompt} maxLength={selectedVideoModel.input.max_prompt_utf16} disabled={busy} onChange={e => setEditPrompt(e.target.value)}/></label>
      <label>このショットの寸法<select aria-label="このショットの寸法" disabled={busy} value={editRatio} onChange={e => setEditRatio(e.target.value)}>{videoRatios.map(r => <option key={r}>{r}</option>)}</select></label>
      <label>このショットの尺<select aria-label="このショットの尺" disabled={busy} value={editDuration} onChange={e => setEditDuration(Number(e.target.value))}>{videoDurations.map(seconds => <option key={seconds} value={seconds}>{seconds}秒</option>)}</select></label>
      <button disabled={busy || !model?.connectionId} onClick={() => run('動きの案を作成中', async () => { setEditPrompt(await draftVideoMotion(current.current, shot, model)); notify('動きの案を作りました。内容を確認して「指示を保存する」で反映できます。'); })}>演出LLMで動きの案を作る</button>
      <button disabled={busy || !editPrompt.trim() || !shotEdited} onClick={() => run('動きの指示を保存', async () => {
        const next = validateVideoShot(current.current, { ...shot, prompt: editPrompt, ratio: editRatio, duration: editDuration });
        await commit({ ...current.current, videoShots: current.current.videoShots.map(s => s.id === shot.id ? next : s) });
      })}>指示を保存する</button>
      {shotRequestError && <p role="alert">{shotRequestError}</p>}
      {shotEdited && <p role="status">変更した指示を保存すると生成できます。</p>}
      <button className="primary" disabled={busy || !desktop() || !activeConnection || !transitionSupported || !!shotRequestError || shotEdited} onClick={() => run('動画要求を送信中', generate)}>{shot.duration}秒の動画を生成する</button>
      {!connectionId && <p>動画API接続を登録すると生成・状態照会を利用できます。</p>}
      {shot.transition && activeConnection && !transitionSupported && <p role="alert">現在の接続・モデルは終端画像に対応していないため、このA→Bショットは送信しません。</p>}
      {project.jobs.filter(j => j.scope?.type === 'videoShot' && j.scope.id === shot.id).map(j => <article key={j.id}>
        <p>{videoStatusLabel(j)} · 予約 {j.remote?.reserved_credits ?? 0} credits{j.remote?.actual_credits != null ? ` / 実績 ${j.remote.actual_credits} credits` : ''}</p>
        {j.remote?.task_id && <><small>task {j.remote.task_id}</small>
          <button disabled={busy || !jobConnectionId(j) || j.status === 'cancelled'} onClick={() => run('動画の状態を照会', () => task(j.id, 'status'))}>状態を更新</button>
          <button disabled={busy || !jobConnectionId(j) || j.remote.status !== 'SUCCEEDED'} onClick={() => run('動画を取得・検証中', () => task(j.id, 'collect'))}>生成済み動画を取得</button>
          {['submitted', 'cancel_requested'].includes(j.status) && <><label><input type="checkbox" checked={acceptDeletion} onChange={e => setAcceptDeletion(e.target.checked)}/>取消時に完了していた結果はサービス上から削除されることを了承する</label><button disabled={busy || !jobConnectionId(j) || !acceptDeletion} onClick={() => run('動画の取消・削除を要求', () => task(j.id, 'cancel'))}>サービスへ取消・削除を要求</button></>}
        </>}
        {['unknown', 'submitted', 'output_pending', 'cancel_requested'].includes(j.status) && !j.output_revision && !j.remote?.artifact && <details><summary>要求・取得を手動で解決する</summary><p>{j.manifest?.connection?.provider === 'ltx-mlx' ? '応答が失われた場合は、MacのアクティビティモニタでLTXのCLIが停止したことを確認してください。この操作はプロセスを停止しません。結果を採用せず解決し、再生成は別の要求として明示実行します。' : '応答消失・期限切れ・task削除等で続行できない場合は、まず同じアカウントのRunway側で要求を確認してください。ローカルで採用せず解決しても、リモート生成は停止せず、料金と予約枠は戻りません。再生成は別の有料要求です。'}</p><label><input type="checkbox" checked={checkedTask === j.id} onChange={e => setCheckedTask(e.target.checked ? j.id : '')}/> {j.manifest?.connection?.provider === 'ltx-mlx' ? 'CLIの停止を確認し、この結果を採用しないことを確認しました' : 'サービス側を確認し、この結果を採用しないことを確認しました'}</label><button disabled={busy || checkedTask !== j.id} onClick={() => run('未確定要求を解決', async () => { await commit(resolveVideoTask(current.current, j.id, checkedTask === j.id)); setCheckedTask(''); })}>採用せずローカルで解決する</button></details>}
      </article>)}
      <button disabled={busy || !desktop() || !project.videoHistory.some(h => h.shot_id === shot.id)} onClick={() => run('動画の採用を元に戻す', async () => { await commit(await undoVideo(current.current, shot.id, verify)); setPlayback(null); })}>この動画の採用を元に戻す</button>
      {project.videoRevisions.filter(v => v.shot_id === shot.id).map(v => {
        const job = project.jobs.find(j => j.id === v.job_id);
        return <article key={v.id}>
          <p>{shot.adopted_revision === v.id ? '採用中' : '保存済み候補'} · {v.artifact.hash.slice(0, 12)}</p>
          <button disabled={busy || !desktop()} onClick={() => run('動画ファイルを確認', () => play(v))}>再生を開く</button>
          <button disabled={busy || !desktop() || job?.status !== 'candidate'} onClick={() => run('動画候補を採用', async () => commit(await adoptVideoCandidate(current.current, v.job_id, verify, loadCapture)))}>この動画を採用</button>
          <button disabled={busy || !desktop()} onClick={() => run('MP4を書き出す', async () => notify(`書き出しました: ${await call('video_export', { revisionId: v.id })}`))}>MP4を書き出す</button>
        </article>;
      })}
    </section>}
    {playback && <video key={playback.revision} controls playsInline preload="metadata" src={playback.src} onError={() => setPlayError('この動画を再生できません。ファイルまたはMacの対応形式を確認してください。')}/>}
    {playError && <p role="alert">{playError}</p>}
  </section>;
}
