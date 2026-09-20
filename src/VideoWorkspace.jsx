import React, { useState, useEffect, useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { call, desktop, loadProject } from './bridge';
import { sourceUnits, sourceForPanel } from './core';
import { createVideoShot, adoptVideoCandidate, undoVideo, beginVideoJob, validateVideoShot, videoConnectionSupportsEndFrame } from './video';
import { adjacentPanelPairs, createSelectedAdjacentVideoShots } from './video-transition';
import { videoStatusLabel, resolveVideoTask } from './video-remote';
import { draftVideoMotion } from './video-plan';
import ShotControls from './ShotControls';
import { videoSources } from './shots';

const loadCapture = (sessionId, requestId) => call('blender_capture', { sessionId, requestId });
export default function VideoWorkspace({ project, current, commit, run, busy, notify, model, requestedShot, requestedPairId, onPairConsumed }) {
  const snapshot = project.snapshots.find(s => s.id === project.active);
  const [sceneId, setSceneId] = useState(''), [imageId, setImageId] = useState(''), [prompt, setPrompt] = useState(''), [selected, setSelected] = useState('');
  useEffect(() => { if (requestedShot) { setSelected(requestedShot); setPlayback(null); } }, [requestedShot]);
  const [playback, setPlayback] = useState(null), [playError, setPlayError] = useState('');
  const [ratio, setRatio] = useState('960:960'), [editRatio, setEditRatio] = useState('960:960');
  const [apiKey, setApiKey] = useState(''), [budget, setBudget] = useState(180), [approved, setApproved] = useState(false), [connectionId, setConnectionId] = useState(''), [acceptDeletion, setAcceptDeletion] = useState(false), [editPrompt, setEditPrompt] = useState('');
  const [captureSourceId, setCaptureSourceId] = useState(''), [captureCharacters, setCaptureCharacters] = useState([]);
  const [transitionPairIds, setTransitionPairIds] = useState([]), [transitionPrompt, setTransitionPrompt] = useState(''), [transitionRatio, setTransitionRatio] = useState('960:960');
  const sources = videoSources(project), captureSource = sources.find(s => s.id === captureSourceId);
  const pairOptions = adjacentPanelPairs(project), pairOptionKey = pairOptions.map(pair => pair.id + ':' + pair.valid).join('|');
  useEffect(() => {
    const available = new Set(pairOptions.filter(pair => pair.valid).map(pair => pair.id));
    setTransitionPairIds(ids => ids.filter(id => available.has(id)));
  }, [pairOptionKey]);
  useEffect(() => {
    if (requestedPairId && pairOptions.some(pair => pair.id === requestedPairId && pair.valid)) {
      setTransitionPairIds(ids => ids.includes(requestedPairId) ? ids : [...ids, requestedPairId]);
    }
  }, [requestedPairId, pairOptionKey]);
  const [checkedTask, setCheckedTask] = useState('');
  const connectionRef = useRef('');
  useEffect(() => () => { if (connectionRef.current) call('remove_video', { connectionId: connectionRef.current }).catch(() => {}); }, []);
  const images = [...project.artworks.map(a => ({ key: `artwork|${a.id}`, kind: 'artwork', id: a.id, hash: a.hash, label: `作画 ${a.panel.sceneId} / ${a.id.slice(-8)}` })),
    ...(project.captures ?? []).map(c => ({ key: `capture|${c.id}`, kind: 'capture', id: c.id, hash: c.image.hash, label: `撮影 ${c.id.slice(-8)}` }))];
  const shot = project.videoShots.find(s => s.id === selected);
  const activeConnection = connectionId ? { id: connectionId, provider: 'runway', model: 'gen4.5' } : null;
  const transitionSupported = !shot?.transition || videoConnectionSupportsEndFrame(activeConnection);
  useEffect(() => { setEditPrompt(shot?.prompt ?? ''); setEditRatio(shot?.ratio ?? '960:960'); setAcceptDeletion(false); setCheckedTask(''); }, [selected, shot?.prompt, shot?.ratio]);
  async function prepareCapture() {
    const p = current.current;
    if(!p.snapshots.find(s=>s.id===p.active)?.scenes.some(s=>s.id===sceneId))throw Error('現在の場面を選択してください');
    const batch={id:crypto.randomUUID(),scope_type:'videoSource',status:'complete',bindings:[{id:crypto.randomUUID(),snapshotId:p.active,source_revision:p.active,sceneId,characterIds:[...captureCharacters]}]};
    await commit({...p,shot_batches:[...(p.shot_batches??[]),batch]});
    setCaptureSourceId(batch.bindings[0].id);
  }
  async function refresh() {
    const latest = await loadProject();
    if (!latest) throw Error('作品を再読込できません');
    await commit(latest);
  }
  async function generate() {
    const connection = { id: connectionId, provider: 'runway', model: 'gen4.5' };
    const started = await beginVideoJob(current.current, shot.id, connection, loadCapture);
    await commit(started.project);
    try { await call('video_submit', { jobId: started.job.id, connectionId }); }
    finally { await refresh(); }
    notify('動画要求を送信しました。「状態を更新」で確認できます。自動で生成を再送しません。');
  }
  async function task(jobId, action) {
    try { await call('video_task', { jobId, connectionId, action, acceptRemoteDeletion: acceptDeletion }); }
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
    <h2>動画ショット</h2><p>同じ原作・作画・撮影画像から、5秒の無音ショットを準備します。</p>
    <details><summary>動画API接続</summary><fieldset disabled={busy || !desktop()}>
      <p>Runway / gen4.5 · 通常は開始画像1枚と動きの指示を api.dev.runwayml.com へ送ります。A→Bは終端画像対応の接続だけで実行します。</p>
      <small>5秒あたり60 creditsの見積り（2026-09-16確認）。作品の累計予約枠を上限にします。失敗・成否不明も予約枠を消費し、再登録でリセットしません。実際の請求額はサービス側でも確認してください。</small>
      <label>Runway APIキー<input aria-label="Runway APIキー" type="password" autoComplete="off" disabled={!!connectionId} value={apiKey} onChange={e => setApiKey(e.target.value)}/></label>
      <label>作品の上限（credits）<input aria-label="作品の上限（credits）" type="number" min="60" max="6000" step="60" disabled={!!connectionId} value={budget} onChange={e => setBudget(Number(e.target.value))}/></label>
      <label><input type="checkbox" disabled={!!connectionId} checked={approved} onChange={e => setApproved(e.target.checked)}/>この送信先・モデル・送信内容・予算内での生成を許可する</label>
      {!connectionId ? <button disabled={!apiKey.trim() || !approved} onClick={() => run('動画接続を登録', async () => {
        const id = await call('register_video', { input: { credential: apiKey, max_credits: budget, approved } });
        connectionRef.current = id; setConnectionId(id); setApiKey('');
        notify('動画接続を登録しました。キーは作品へ保存しません。');
      })}>接続を登録する</button> : <button onClick={() => run('動画接続を解除', async () => { await call('remove_video', { connectionId }); connectionRef.current = ''; setConnectionId(''); setApproved(false); })}>接続を解除する</button>}
      <small>再起動後は同じRunwayアカウントのキーを再登録して、保存済みtaskを確認してください。登録だけでは有料要求を送りません。</small>
    </fieldset></details>
    {!snapshot ? <p>接続・人物設定から原作を取得してください。</p> : <fieldset disabled={busy}>
      <legend>ショットを追加</legend>
      <label>原作の場面<select aria-label="原作の場面" value={sceneId} onChange={e => { setSceneId(e.target.value); setCaptureCharacters([]); }}><option value="">場面を選択</option>{snapshot.scenes.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
      <details><summary>開いているBlender GUIから動画用に撮影</summary>
        <p>接続・人物設定で開いた素材から専用ショットを作ります。漫画のコマは不要です。別のコマ・動画のカメラやフレームは変更しません。</p>
        <label>撮影する人物<select aria-label="撮影する人物" multiple value={captureCharacters} onChange={e => setCaptureCharacters([...e.target.selectedOptions].map(o => o.value))}>{project.characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <button disabled={!desktop() || !sceneId} onClick={() => run('動画用の撮影を準備', prepareCapture)}>動画用の撮影ショットを作る</button>
        <label>動画用の撮影ショット<select aria-label="動画用の撮影ショット" value={captureSourceId} onChange={e => setCaptureSourceId(e.target.value)}><option value="">撮影対象を選択</option>{sources.map(s => <option key={s.id} value={s.id}>{s.sceneId} · {s.id.slice(0, 8)}</option>)}</select></label>
        <ShotControls project={project} current={current} commit={commit} panels={[]} chosen={captureSource} busy={busy} run={run} scopeType="videoSource" captureSize={ratio.split(':').map(Number)}/>
        {captureSource?.capture_revision && <button onClick={() => {
          if (captureSource.snapshotId !== project.active) { notify('旧原作の撮影です。現在の場面で新しい撮影ショットを作ってください。'); return; }
          setSceneId(captureSource.sceneId); setImageId(`capture|${captureSource.capture_revision}`);
          notify('撮影を開始画像に選びました。動きの指示を入力してショットを保存してください。');
        }}>この撮影を開始画像に使う</button>}
      </details>
      <label>開始画像<select aria-label="開始画像" value={imageId} onChange={e => setImageId(e.target.value)}><option value="">保存済みの画像を選択</option>{images.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></label>
      <label>動きの指示<textarea aria-label="動きの指示" value={prompt} maxLength={1000} onChange={e => setPrompt(e.target.value)} placeholder="カメラがゆっくり寄る。人物は小さくうなずく。"/></label>
      <label>動画の寸法<select aria-label="動画の寸法" value={ratio} onChange={e => setRatio(e.target.value)}>{['960:960','1280:720','720:1280','1104:832','832:1104'].map(r => <option key={r}>{r}</option>)}</select></label><small>PNGの開始画像と同じ縦横比を選んでください。比率が違う画像の自動切り抜きは拒否します。</small>
      <button disabled={!sceneId || !imageId || !prompt.trim()} onClick={() => run('動画ショットを保存', async () => {
        const p = current.current, scene = snapshot.scenes.find(s => s.id === sceneId), image = images.find(a => a.key === imageId);
        if (!scene || !image) throw Error('場面・画像を選び直してください');
        const artwork = p.artworks.find(a => a.id === image.id);
        const captured = p.captures?.find(c => c.id === image.id);
        const characterIds = [...new Set(artwork?.panel.characterIds ?? captured?.character_ids ?? captured?.character_bindings?.map(b => b.character_id) ?? [])];
        const next = createVideoShot(p, { snapshotId: snapshot.id, sceneId, unitIds: sourceUnits(sceneId, scene.text).map(u => u.id), characterIds,
          startImage: { kind: image.kind, id: image.id, hash: image.hash }, prompt, duration: 5, ratio });
        await commit(next); setSelected(next.videoShots.at(-1).id); setPlayback(null);
      })}>ショットを保存</button>
      <small>選択した場面の原文全体を参照します。台詞音声は生成しません。</small>
      <details>
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
        <label>隣接コマ間の動き<textarea aria-label="隣接コマ間の動き" maxLength={1000} value={transitionPrompt} onChange={e => setTransitionPrompt(e.target.value)} placeholder="AからBへゆっくりカメラが移動する。"/></label>
        <label>隣接コマ動画の寸法<select aria-label="隣接コマ動画の寸法" value={transitionRatio} onChange={e => setTransitionRatio(e.target.value)}>{['960:960','1280:720','720:1280','1104:832','832:1104'].map(r => <option key={r}>{r}</option>)}</select></label>
        <button
          disabled={!transitionPairIds.length || !transitionPrompt.trim()}
          onClick={() => run('選択した隣接コマを保存', async () => {
            const p = current.current;
            const next = createSelectedAdjacentVideoShots(p, transitionPairIds, { prompt: transitionPrompt, duration: 5, ratio: transitionRatio });
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
      <h3>{shot.transition ? shot.transition.fromPanelId + ' → ' + shot.transition.toPanelId : shot.sceneId} · 5秒 · 無音</h3>
      <p className="video-source">{sourceForPanel(shot, project.snapshots.find(s => s.id === shot.snapshotId))}</p>
      <p>{shot.prompt}</p><small>開始画像 {shot.startImage.hash.slice(0, 12)}{shot.endImage ? ' · 終端画像 ' + shot.endImage.hash.slice(0, 12) : ''} · {shot.ratio}</small>
      <label>このショットの動き<textarea aria-label="このショットの動き" value={editPrompt} maxLength={1000} disabled={busy} onChange={e => setEditPrompt(e.target.value)}/></label>
      <label>このショットの寸法<select aria-label="このショットの寸法" disabled={busy} value={editRatio} onChange={e => setEditRatio(e.target.value)}>{['960:960','1280:720','720:1280','1104:832','832:1104'].map(r => <option key={r}>{r}</option>)}</select></label>
      <button disabled={busy || !model?.connectionId} onClick={() => run('動きの案を作成中', async () => { setEditPrompt(await draftVideoMotion(current.current, shot, model)); notify('動きの案を作りました。内容を確認して「指示を保存する」で反映できます。'); })}>演出LLMで動きの案を作る</button>
      <button disabled={busy || !editPrompt.trim() || (editPrompt === shot.prompt && editRatio === shot.ratio)} onClick={() => run('動きの指示を保存', async () => {
        const next = validateVideoShot(current.current, { ...shot, prompt: editPrompt, ratio: editRatio });
        await commit({ ...current.current, videoShots: current.current.videoShots.map(s => s.id === shot.id ? next : s) });
      })}>指示を保存する</button>
      <button className="primary" disabled={busy || !desktop() || !connectionId || !transitionSupported} onClick={() => run('動画要求を送信中', generate)}>5秒の動画を生成する</button>
      {!connectionId && <p>動画API接続を登録すると生成・状態照会を利用できます。</p>}
      {shot.transition && connectionId && !transitionSupported && <p role="alert">現在のRunway / gen4.5は終端画像に対応していないため、このA→Bショットは有料送信しません。</p>}
      {project.jobs.filter(j => j.scope?.type === 'videoShot' && j.scope.id === shot.id).map(j => <article key={j.id}>
        <p>{videoStatusLabel(j)} · 予約 {j.remote?.reserved_credits ?? 0} credits{j.remote?.actual_credits != null ? ` / 実績 ${j.remote.actual_credits} credits` : ''}</p>
        {j.remote?.task_id && <><small>task {j.remote.task_id}</small>
          <button disabled={busy || !connectionId || j.status === 'cancelled'} onClick={() => run('動画の状態を照会', () => task(j.id, 'status'))}>状態を更新</button>
          <button disabled={busy || !connectionId || j.remote.status !== 'SUCCEEDED'} onClick={() => run('動画を取得・検証中', () => task(j.id, 'collect'))}>生成済み動画を取得</button>
          {['submitted', 'cancel_requested'].includes(j.status) && <><label><input type="checkbox" checked={acceptDeletion} onChange={e => setAcceptDeletion(e.target.checked)}/>取消時に完了していた結果はサービス上から削除されることを了承する</label><button disabled={busy || !connectionId || !acceptDeletion} onClick={() => run('動画の取消・削除を要求', () => task(j.id, 'cancel'))}>サービスへ取消・削除を要求</button></>}
        </>}
        {['unknown', 'submitted', 'output_pending', 'cancel_requested'].includes(j.status) && !j.output_revision && !j.remote?.artifact && <details><summary>要求・取得を手動で解決する</summary><p>応答消失・期限切れ・task削除等で続行できない場合は、まず同じアカウントのRunway側で要求を確認してください。ローカルで採用せず解決しても、リモート生成は停止せず、料金と予約枠は戻りません。再生成は別の有料要求です。</p><label><input type="checkbox" checked={checkedTask === j.id} onChange={e => setCheckedTask(e.target.checked ? j.id : '')}/>サービス側を確認し、この結果を採用しないことを確認しました</label><button disabled={busy || checkedTask !== j.id} onClick={() => run('未確定要求を解決', async () => { await commit(resolveVideoTask(current.current, j.id, checkedTask === j.id)); setCheckedTask(''); })}>採用せずローカルで解決する</button></details>}
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
