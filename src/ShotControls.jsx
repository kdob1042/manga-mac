import React, { useEffect, useState } from 'react';
import { call, desktop } from './bridge';
import { planShots, attachShots, bindCharacter, recordCapture } from './shots';

export default function ShotControls({ project, current, commit, panels, chosen, busy, run }) {
  const [session, setSession] = useState(null), [preview, setPreview] = useState(null);
  const [scene, setScene] = useState(''), [camera, setCamera] = useState(''), [frame, setFrame] = useState(1), [lens, setLens] = useState(50);
  const [width, setWidth] = useState(768), [height, setHeight] = useState(768);
  const [character, setCharacter] = useState(''), [object, setObject] = useState('');
  function display(s) {
    setSession(s); setPreview(s.preview ?? null);
    const state = s.state?.state;
    if (state) { setScene(state.scene); setCamera(state.camera); setFrame(state.frame); setLens(state.lens); }
    return s;
  }
  const refresh = async () => display(await call('blender_status', { sessionId: chosen.shot_binding.session_id }));
  useEffect(() => { setSession(null); setPreview(null); setCharacter(''); setObject(''); }, [chosen?.id]);
  const unresolved = project.shot_batches?.filter(b => b.status === 'unknown') ?? [];
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
      if (operation.kind === 'capture') await commit(await recordCapture(current.current, chosen.id, result));
    } catch (error) { await refresh().catch(() => {}); throw error; }
  }
  const pending = session?.jobs?.filter(j => ['unknown', 'running', 'candidate'].includes(j.status)) ?? [];
  const selectedScene = session?.state?.scenes?.find(s => s.name === scene);
  return <section className="shot-controls" aria-label="Blenderショット">
    <h3>Blenderで構図・撮影</h3>
    <button disabled={busy || !desktop() || !panels.some(p => !p.shot_binding)} onClick={() => run('ページのショットを準備中', attach)}>このページのショットを作る</button>
    {unresolved.map(batch => <div key={batch.id}><span>未確定ショット {batch.id.slice(0, 8)}</span><button disabled={busy} onClick={() => run('既存ショットを確認中', async () => {
      const sessions = await Promise.all(batch.bindings.map(b => call('blender_status', { sessionId: b.id })));
      await commit(attachShots(current.current, batch, sessions));
    })}>保存済みショットを復元</button><button disabled={busy} onClick={() => run('ショット割当を取り下げ', async () => commit({ ...current.current, shot_batches: current.current.shot_batches.map(b => b.id === batch.id ? { ...b, status: 'abandoned' } : b) }))}>割当を取り下げる</button></div>)}
    {chosen?.shot_binding && <>
      <p>選択コマ：{chosen.id}</p><button disabled={busy} onClick={() => run('Blenderの状態を取得中', refresh)}>構図・素材を読み込む</button>
      {session && <fieldset disabled={busy}>
        <label>Scene<select value={scene} onChange={e => { setScene(e.target.value); setCamera(''); }}>{session.state?.scenes?.map(s => <option key={s.name}>{s.name}</option>)}</select></label>
        <label>Camera<select value={camera} onChange={e => setCamera(e.target.value)}><option value="">選択</option>{selectedScene?.cameras.map(name => <option key={name}>{name}</option>)}</select></label>
        <label>フレーム<input type="number" min="-1048574" max="1048574" value={frame} onChange={e => setFrame(Number(e.target.value))}/></label>
        <button disabled={!camera || pending.length > 0} onClick={() => run('対象ショットを変更中', () => operate({ kind: 'shot', scene, camera, frame }))}>このコマの構図を適用</button>
        <label>焦点距離<input type="number" min="10" max="250" value={lens} onChange={e => setLens(Number(e.target.value))}/></label>
        <button disabled={pending.length > 0} onClick={() => run('カメラを変更中', () => operate({ kind: 'camera', lens }))}>このコマのカメラを変更</button>
        <label>撮影幅<input type="number" min="64" max="4096" value={width} onChange={e => setWidth(Number(e.target.value))}/></label>
        <label>撮影高さ<input type="number" min="64" max="4096" value={height} onChange={e => setHeight(Number(e.target.value))}/></label>
        <button disabled={pending.length > 0} onClick={() => run('撮影原本を保存中', () => operate({ kind: 'capture', width, height }))}>このコマを撮影</button>
        {!pending.length && session.state?.image && session.jobs?.find(j => j.status === 'complete') && <button onClick={() => run('保存済み撮影をコマへ接続中', async () => {
          const job = session.jobs.find(j => j.status === 'complete');
          const result = await call('blender_capture', { sessionId: session.session_id, requestId: job.id });
          await commit(await recordCapture(current.current, chosen.id, result));
        })}>保存済み撮影をこのコマへ接続</button>}
        {pending.map(job => <div key={job.id}><span>未確定の処理 {job.id.slice(0, 8)}</span>{['adopt', 'abandon'].map(action => <button key={action} disabled={job.status === 'running' || (action === 'adopt' && job.expected_revision !== session.revision)} onClick={() => run('保存結果を確認中', async () => {
          const result = display(await call('blender_recover', { sessionId: session.session_id, requestId: job.id, expectedRevision: session.revision, action }));
          if (action === 'adopt' && result.state?.image) await commit(await recordCapture(current.current, chosen.id, { ...result, request_id: job.id }));
        })}>{action === 'adopt' ? '保存結果を採用' : '採用せず解決'}</button>)}</div>)}
        {chosen.characterIds.length > 0 && <><label>人物<select value={character} onChange={e => setCharacter(e.target.value)}><option value="">選択</option>{chosen.characterIds.map(id => <option key={id} value={id}>{project.characters.find(c => c.id === id)?.name ?? id}</option>)}</select></label><label>BlenderのObject<select value={object} onChange={e => setObject(e.target.value)}><option value="">選択</option>{session.state?.scenes?.find(s => s.name === session.state.state.scene)?.objects.map(name => <option key={name}>{name}</option>)}</select></label><button disabled={!object || !character} onClick={() => run('人物と素材を対応付け', async () => commit(bindCharacter(current.current, chosen.id, character, object, session)))}>人物と素材を対応付ける</button></>}
        <details><summary>Blenderに登録された素材</summary>{session.state?.assets?.map((a, i) => <p key={i}>{a.name} · {a.kind} · {a.tags?.join(', ')} · {a.catalog_id}</p>)}</details>
      </fieldset>}
      {chosen.capture_revision && <button disabled={busy} onClick={() => run('撮影原本を読み込み中', async () => { const c = current.current.captures.find(c => c.id === chosen.capture_revision); const result = await call('blender_capture', { sessionId: c.session_id, requestId: c.request_id }); setPreview(result.preview); })}>採用中の撮影原本を表示</button>}
      {preview && <img className="shot-preview" src={preview} alt="Blender撮影原本"/>}
    </>}
  </section>;
}
