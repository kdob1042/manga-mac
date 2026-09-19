import { recordLiveCandidate, adoptLiveCandidate } from './live-candidates';
import { liveCall, handoffLive, verifyLiveMappings, assertLiveTarget } from './live-blender';
import React, { useEffect, useState } from 'react';
import { call, desktop } from './bridge';
import { previousCaptureUsers, usageLabel } from './asset-usage';
import { planShots, attachShots, bindCharacter, recordCapture } from './shots';

export default function ShotControls({ project, current, commit, panels, chosen, busy, run, scopeType = 'panel', captureSize }) {
  const [liveMessage, setLiveMessage] = useState(''), [livePreview, setLivePreview] = useState(null);
  const [liveBinary, setLiveBinary] = useState('/Applications/Blender.app/Contents/MacOS/Blender');
  const [session, setSession] = useState(null), [preview, setPreview] = useState(null);
  const [scene, setScene] = useState(''), [camera, setCamera] = useState(''), [frame, setFrame] = useState(1), [lens, setLens] = useState(50);
  const [width, setWidth] = useState(768), [height, setHeight] = useState(768);
  const [rig, setRig] = useState(''), [pose, setPose] = useState(''), [poseFrame, setPoseFrame] = useState(1);
  const [character, setCharacter] = useState(''), [object, setObject] = useState('');
  function display(s) {
    setSession(s); setPreview(s.preview ?? null);
    const state = s.state?.state;
    if (state) { setScene(state.scene); setCamera(state.camera); setFrame(state.frame); setLens(state.lens); }
    return s;
  }
  const refresh = async () => display(await call('blender_status', { sessionId: chosen.shot_binding.session_id }));
  useEffect(() => { setLivePreview(null); setLiveMessage(''); setSession(null); setPreview(null); setCharacter(''); setObject(''); setRig(''); setPose(''); setPoseFrame(1); }, [chosen?.id]);
  const isVideo = scopeType === 'videoSource', targetLabel = isVideo ? '動画用撮影' : 'コマ';
  const unresolved = project.shot_batches?.filter(b => b.status === 'unknown' && (b.scope_type ?? 'panel') === scopeType) ?? [];
  async function attach() {
    const base = await call('blender_latest');
    const batch = planShots(current.current, panels.filter(p => !p.shot_binding).map(p => p.id), base);
    await commit({ ...current.current, shot_batches: [...(current.current.shot_batches ?? []), batch] });
    const sessions = await call('blender_fork', { sessionId: batch.base_session, expectedRevision: batch.base_revision, ids: batch.bindings.map(b => b.id) });
    await commit(attachShots(current.current, batch, sessions));
  }
  async function operate(operation) {
    const live = await refresh();
    try {
      const result = display(await call('blender_execute', { request: { session_id: live.session_id, request_id: crypto.randomUUID(), expected_revision: live.revision, operation } }));
      if (operation.kind === 'capture') await commit(await recordCapture(current.current, chosen.id, result, scopeType));
    } catch (error) { await refresh().catch(() => {}); throw error; }
  }
  const pending = session?.jobs?.filter(j => ['unknown', 'running', 'candidate'].includes(j.status)) ?? [];
  const oldUsers = chosen?.capture_revision ? previousCaptureUsers(project, chosen.capture_revision) : [];
  const selectedScene = session?.state?.scenes?.find(s => s.name === scene);
  return <section className="shot-controls" aria-label="Blenderショット">
    <h3>Blenderで構図・撮影</h3>
    {!isVideo && chosen && <><button disabled={busy} onClick={()=>run('live対象を確認中',async()=>{
      const state=await liveCall(call,current.current,'observe',{scope:'summary'});
      await commit({...current.current,panels:current.current.panels.map(p=>p.id===chosen.id?{...p,live_binding:{...Object.fromEntries(['instance','epoch','file','scene','view_layer'].map(k=>[k,state[k]])),objects:state.objects}}:p)});
    })}>このコマを接続中のlive状態へ割り当てる</button>
    {chosen.live_binding && <>
      <button onClick={async()=>{try {await handoffLive(call,current.current);setLiveMessage('再開待ち：同じBlender GUIを手動または外部Computer Useで編集できます。実行済み操作は残り、未送信計画は破棄しました。');}catch(e){setLiveMessage(e.message);}}}>手動・Computer Useへ渡す（AI書込み停止）</button>
      <button disabled={busy} onClick={()=>run('live状態を再観測中',async()=>{
        const s=await liveCall(call,current.current,'observe',{scope:'summary'});assertLiveTarget(chosen.live_binding,s);verifyLiveMappings(current.current,chosen,s);
        setLivePreview(await liveCall(call,current.current,'observe',{scope:'camera'}));setLiveMessage('再観測済み。自然言語の演出指示から新しい計画で再開できます。');
      })}>再観測して再開準備</button>
      <p>{liveMessage}</p>{livePreview&&<img className="shot-preview" src={livePreview.image??livePreview.preview} alt="live candidate camera"/>}
      <label>候補撮影用Blender実行ファイル<input value={liveBinary} onChange={e=>setLiveBinary(e.target.value)}/></label>
      <button disabled={busy} onClick={()=>run('live編集を新しい候補へ保存中',async()=>{
        const base=current.current.panels.find(p=>p.id===chosen.id);
        await handoffLive(call,current.current);
        const observed=await liveCall(call,current.current,'observe',{scope:'summary'});assertLiveTarget(base.live_binding,observed);verifyLiveMappings(current.current,base,observed);
        const result=await call('blender_live_candidate',{input:{work:JSON.stringify([current.current.workId??'',current.current.snapshots?.find(s=>s.id===current.current.active)?.repo??'',current.current.active]),expected:observed},binary:liveBinary});
        await commit(await recordLiveCandidate(current.current,chosen.id,result,base));setLivePreview(result);setLiveMessage('新しい候補として保存しました。旧採用版は保持しています。');
      })}>見た目を確認し、新しい候補版へ保存</button>
      {(project.live_candidates??[]).filter(c=>c.panel_id===chosen.id).map(c=><div key={c.id}><span>候補 {c.id.slice(-8)}</span><button disabled={busy} onClick={()=>run('候補を表示中',async()=>{const capture=current.current.captures.find(x=>x.id===c.capture_revision);setLivePreview(await call('blender_capture',{sessionId:capture.session_id,requestId:capture.request_id}));})}>候補を表示</button><button disabled={busy} onClick={()=>run('live候補を採用中',()=>commit(adoptLiveCandidate(current.current,c.id)))}>この候補を採用</button></div>)}
      <p>LIVE: {chosen.live_binding.file||'未保存'} ／ {chosen.live_binding.scene}</p><button disabled={busy} onClick={()=>run('headlessへ切替中',()=>commit({...current.current,panels:current.current.panels.map(p=>p.id===chosen.id?{...p,live_binding:null}:p)}))}>保存ファイルからのheadlessへ戻す</button></>}
    {(project.live_directing_runs??[]).filter(r=>r.panel_id===chosen.id).slice(-1).map(r=><div key={r.id}><p>{({running:'AI操作中',paused:'再開待ち',confirm:'確認待ち',blocked:'停止（要確認）'})[r.status]??r.status}：{r.message}</p>{r.preview&&<img className="shot-preview" src={r.preview} alt={r.image_kind}/>}</div>)}</>}

    {!isVideo && <button disabled={busy || !desktop() || !panels.some(p => !p.shot_binding)} onClick={() => run('ページのショットを準備中', attach)}>このページのショットを作る</button>}
    {unresolved.map(batch => <div key={batch.id}><span>未確定ショット {batch.id.slice(0, 8)}</span><button disabled={busy} onClick={() => run('既存ショットを確認中', async () => {
      const sessions = await Promise.all(batch.bindings.map(b => call('blender_status', { sessionId: b.id })));
      await commit(attachShots(current.current, batch, sessions));
    })}>保存済みショットを復元</button><button disabled={busy} onClick={() => run('ショット割当を取り下げ', async () => commit({ ...current.current, shot_batches: current.current.shot_batches.map(b => b.id === batch.id ? { ...b, status: 'abandoned' } : b) }))}>割当を取り下げる</button></div>)}
    {chosen?.shot_binding && <>
      <p>選択{targetLabel}：{chosen.id}</p><button disabled={busy} onClick={() => run('Blenderの状態を取得中', refresh)}>構図・素材を読み込む</button>
      {session && <fieldset disabled={busy}>
        <label>Scene<select aria-label="Scene" value={scene} onChange={e => { setScene(e.target.value); setCamera(''); }}>{session.state?.scenes?.map(s => <option key={s.name}>{s.name}</option>)}</select></label>
        <label>Camera<select aria-label="Camera" value={camera} onChange={e => setCamera(e.target.value)}><option value="">選択</option>{selectedScene?.cameras.map(name => <option key={name}>{name}</option>)}</select></label>
        <label>フレーム<input aria-label="フレーム" type="number" min="-1048574" max="1048574" value={frame} onChange={e => setFrame(Number(e.target.value))}/></label>
        <button disabled={!camera || pending.length > 0} onClick={() => run('対象ショットを変更中', () => operate({ kind: 'shot', scene, camera, frame }))}>この{targetLabel}の構図を適用</button>
        <label>焦点距離<input aria-label="焦点距離" type="number" min="10" max="250" value={lens} onChange={e => setLens(Number(e.target.value))}/></label>
        <button disabled={pending.length > 0} onClick={() => run('カメラを変更中', () => operate({ kind: 'camera', lens }))}>この{targetLabel}のカメラを変更</button>
        {!isVideo && <><label>撮影幅<input aria-label="撮影幅" type="number" min="64" max="4096" value={width} onChange={e => setWidth(Number(e.target.value))}/></label>
        <label>撮影高さ<input aria-label="撮影高さ" type="number" min="64" max="4096" value={height} onChange={e => setHeight(Number(e.target.value))}/></label></>}
        {isVideo && <p>撮影寸法 {captureSize?.join(" × ")} · 動画と同じ縦横比で撮影します。</p>}
        <button disabled={pending.length > 0} onClick={() => run('撮影原本を保存中', () => operate({ kind: 'capture', width: captureSize?.[0] ?? width, height: captureSize?.[1] ?? height }))}>この{targetLabel}を撮影</button>
        {!pending.length && session.state?.image && session.jobs?.find(j => j.status === 'complete') && <button onClick={() => run('保存済み撮影をコマへ接続中', async () => {
          const job = session.jobs.find(j => j.status === 'complete');
          const result = await call('blender_capture', { sessionId: session.session_id, requestId: job.id });
          await commit(await recordCapture(current.current, chosen.id, result, scopeType));
        })}>保存済み撮影をこの{targetLabel}へ接続</button>}
        {pending.map(job => <div key={job.id}><span>未確定の処理 {job.id.slice(0, 8)}</span>{['adopt', 'abandon'].map(action => <button key={action} disabled={job.status === 'running' || (action === 'adopt' && job.expected_revision !== session.revision)} onClick={() => run('保存結果を確認中', async () => {
          const result = display(await call('blender_recover', { sessionId: session.session_id, requestId: job.id, expectedRevision: session.revision, action }));
          if (action === 'adopt' && result.state?.image) await commit(await recordCapture(current.current, chosen.id, { ...result, request_id: job.id }, scopeType));
        })}>{action === 'adopt' ? '保存結果を採用' : '採用せず解決'}</button>)}</div>)}
        {chosen.characterIds.length > 0 && <><label>人物<select aria-label="人物" value={character} onChange={e => setCharacter(e.target.value)}><option value="">選択</option>{chosen.characterIds.map(id => <option key={id} value={id}>{project.characters.find(c => c.id === id)?.name ?? id}</option>)}</select></label><label>BlenderのObject<select aria-label="BlenderのObject" value={object} onChange={e => setObject(e.target.value)}><option value="">選択</option>{session.state?.scenes?.find(s => s.name === session.state.state.scene)?.objects.map(name => <option key={name}>{name}</option>)}</select></label><button disabled={!object || !character} onClick={() => run('人物と素材を対応付け', async () => commit(bindCharacter(current.current, chosen.id, character, object, session, scopeType)))}>人物と素材を対応付ける</button></>}
        {session.state?.operations?.includes('pose') && <details><summary>登録済みポーズを適用</summary>
          <p>このSceneの静止リグへ、同じ撮影パック内のポーズ素材を適用します。アニメーション・制約付きリグは未対応です。適用後に撮影して比較してください。</p>
          <label>ポーズ対象リグ<select aria-label="ポーズ対象リグ" value={rig} onChange={e => setRig(e.target.value)}><option value="">選択</option>{session.state.rigs?.map(name => <option key={name}>{name}</option>)}</select></label>
          <label>ポーズ素材<select aria-label="ポーズ素材" value={pose} onChange={e => setPose(e.target.value)}><option value="">選択</option>{session.state.assets?.filter(a => a.kind === 'ACTION' && !a.library).map(a => <option key={a.name}>{a.name}</option>)}</select></label>
          <label>ポーズのフレーム<input aria-label="ポーズのフレーム" type="number" min="-1048574" max="1048574" value={poseFrame} onChange={e => setPoseFrame(Number(e.target.value))}/></label>
          <button disabled={!rig || !pose || pending.length > 0} onClick={() => run('対象リグへポーズを適用中', () => operate({ kind: 'pose', rig, action: pose, frame: poseFrame }))}>この{targetLabel}のポーズを適用</button>
        </details>}
        <details><summary>Blenderに登録された素材</summary>{session.state?.assets?.map((a, i) => <p key={i}>{a.name} · {a.kind} · {a.tags?.join(', ')} · {a.catalog_id}</p>)}</details>
      </fieldset>}
      {chosen.capture_revision && <button disabled={busy} onClick={() => run('撮影原本を読み込み中', async () => { const c = current.current.captures.find(c => c.id === chosen.capture_revision); const result = await call('blender_capture', { sessionId: c.session_id, requestId: c.request_id }); setPreview(result.preview); })}>採用中の撮影原本を表示</button>}
      {!!oldUsers.length && <details><summary>旧撮影を使っている漫画・動画（{oldUsers.length}件）</summary><p>再撮影後もこれらの開始画像・採用版は保持されています。変更する場合は新しい撮影から候補を作って比較してください。</p><ul>{oldUsers.map(row => <li key={`${row.type}:${row.id}`}>{usageLabel(row)}</li>)}</ul></details>}
      {preview && <img className="shot-preview" src={preview} alt="Blender撮影原本"/>}
    </>}
  </section>;
}
