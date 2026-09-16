import React, { useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { call, desktop } from './bridge';
import { sourceUnits, sourceForPanel } from './core';
import { createVideoShot, adoptVideoCandidate, undoVideo } from './video';

const loadCapture = (sessionId, requestId) => call('blender_capture', { sessionId, requestId });
export default function VideoWorkspace({ project, current, commit, run, busy, notify }) {
  const snapshot = project.snapshots.find(s => s.id === project.active);
  const [sceneId, setSceneId] = useState(''), [imageId, setImageId] = useState(''), [prompt, setPrompt] = useState(''), [selected, setSelected] = useState('');
  const [playback, setPlayback] = useState(null), [playError, setPlayError] = useState('');
  const images = [...project.artworks.map(a => ({ key: `artwork|${a.id}`, kind: 'artwork', id: a.id, hash: a.hash, label: `作画 ${a.panel.sceneId} / ${a.id.slice(-8)}` })),
    ...(project.captures ?? []).map(c => ({ key: `capture|${c.id}`, kind: 'capture', id: c.id, hash: c.image.hash, label: `撮影 ${c.id.slice(-8)}` }))];
  const shot = project.videoShots.find(s => s.id === selected);
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
    {!snapshot ? <p>接続・人物設定から原作を取得してください。</p> : <fieldset disabled={busy}>
      <legend>ショットを追加</legend>
      <label>原作の場面<select value={sceneId} onChange={e => setSceneId(e.target.value)}><option value="">場面を選択</option>{snapshot.scenes.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
      <label>開始画像<select value={imageId} onChange={e => setImageId(e.target.value)}><option value="">保存済みの画像を選択</option>{images.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></label>
      <label>動きの指示<textarea value={prompt} maxLength={1000} onChange={e => setPrompt(e.target.value)} placeholder="カメラがゆっくり寄る。人物は小さくうなずく。"/></label>
      <button disabled={!sceneId || !imageId || !prompt.trim()} onClick={() => run('動画ショットを保存', async () => {
        const p = current.current, scene = snapshot.scenes.find(s => s.id === sceneId), image = images.find(a => a.key === imageId);
        if (!scene || !image) throw Error('場面・画像を選び直してください');
        const artwork = p.artworks.find(a => a.id === image.id);
        const captured = p.captures?.find(c => c.id === image.id);
        const characterIds = [...new Set(artwork?.panel.characterIds ?? captured?.character_bindings?.map(b => b.character_id) ?? [])];
        const next = createVideoShot(p, { snapshotId: snapshot.id, sceneId, unitIds: sourceUnits(sceneId, scene.text).map(u => u.id), characterIds,
          startImage: { kind: image.kind, id: image.id, hash: image.hash }, prompt, duration: 5, ratio: '1280:720' });
        await commit(next); setSelected(next.videoShots.at(-1).id); setPlayback(null);
      })}>ショットを保存</button>
      <small>選択した場面の原文全体を参照します。台詞音声は生成しません。</small>
    </fieldset>}
    <nav aria-label="動画ショット一覧">{project.videoShots.map((s, i) => <button key={s.id} aria-pressed={selected === s.id} disabled={busy} onClick={() => { setSelected(s.id); setPlayback(null); setPlayError(''); }}>{i + 1} · {s.sceneId}</button>)}</nav>
    {shot && <section>
      <h3>{shot.sceneId} · 5秒 · 無音</h3>
      <p className="video-source">{sourceForPanel(shot, project.snapshots.find(s => s.id === shot.snapshotId))}</p>
      <p>{shot.prompt}</p><small>開始画像 {shot.startImage.hash.slice(0, 12)} · {shot.ratio}</small>
      <p>動画API接続は次の実装段階です。現在はショットの保存と、保存済み動画の確認・採用を利用できます。</p>
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
