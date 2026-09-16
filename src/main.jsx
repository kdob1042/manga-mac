import LayoutEditor from './LayoutEditor';
import { pagePanels, ensureLayout, layoutWarnings } from './layout.js';
import { directPanel, activeDirection, abandonDirection } from './directing';
import { askLLM } from './llm';
import VideoWorkspace from './VideoWorkspace';
import LetteringControls from './LetteringControls';
import { editRoute } from './edit-route';
import { recordCapture } from './shots';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { emptyProject, sourceForPanel, affectedScenes, revise, sourceUnits } from './core';
import { call, desktop, loadProject, saveProject } from './bridge';
import { syncSource, planScene, generatePanel, editRegion } from './pipeline';
import { exportCBZ, pagePNG, download } from './render';
import './style.css';
import LLMSettings from './LLMSettings';
import { defaultConnection, cancelLLMRequests } from './llm';
import BlenderSettings from './BlenderSettings';
import BackupSettings, { useBackupSchedule } from './BackupSettings';
import ShotControls from './ShotControls';
import { recoverImageResult } from './image-recovery';
import { beginJob, finishJob, adoptCandidate, abandonJob } from './revisions';
import { createEnglishLocalization, currentEnglishLocalization, textForPanel } from './localization';
import { contractLabel, mergeSourceReferences } from './source-contract';

function App() {
  const [layoutMode,setLayoutMode] = useState(false);
  const [productionMode, setProductionMode] = useState('blender');
  const [medium, setMedium] = useState('manga');
  const [project, setProject] = useState(emptyProject), [ready, setReady] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [settings, setSettings] = useState(false), [pagePreview, setPagePreview] = useState(null);
  const [repo, setRepo] = useState('kdob1042/Kamiya-Kawai'), [token, setToken] = useState(''), [episode, setEpisode] = useState('P01'), [model, setModel] = useState(() => defaultConnection());
  const [page, setPage] = useState(0), [selected, setSelected] = useState(null), [instruction, setInstruction] = useState(''), [pending, setPending] = useState(null), [rect, setRect] = useState(null), [name, setName] = useState(''), [description, setDescription] = useState('');
  useBackupSchedule(ready, !!busy);
  const current = useRef(project), cancel = useRef(false), drag = useRef(null), lock = useRef(false);
  useEffect(() => { loadProject().then(p => { if (p) { current.current = p; setProject(p); const s = p.snapshots.find(s => s.id === p.active); if (s?.repo) setRepo(s.repo); } setReady(true); }).catch(e => setError(`保存作品を読み込めません: ${e.message}`)); }, []);
  async function commit(p) { setPagePreview(null); const saved = await saveProject({ ...p, revision: (current.current.revision ?? 0) + 1 }); current.current = saved; setProject(saved); return saved; }
  async function run(label, fn) { if (lock.current) return; lock.current = true; setBusy(label); setError(''); setNotice(''); cancel.current = false; try { await fn(); } catch (e) { setError(e.message ?? String(e)); } finally { setBusy(''); lock.current = false; } }
  const snapshot = project.snapshots.find(s => s.id === project.active), layout = project.layout ?? ensureLayout(project).layout, pageData = layout.pages[page], panels = pagePanels(project,pageData), chosen = project.panels.find(p => p.id === selected);
  const english = currentEnglishLocalization(project, snapshot);
  function panelText(panel) {
    const panelSnapshot = project.snapshots.find(s => s.id === panel.snapshotId);
    if (project.output_locale !== 'en') return textForPanel(panel, panelSnapshot);
    const localization = project.localizations.find(item => item.locale === 'en' && item.snapshot_id === panel.snapshotId);
    return localization ? textForPanel(panel, panelSnapshot, localization) : '英訳未作成';
  }
  async function translateEnglish() {
    if (!snapshot) throw Error('まず原作を接続してください');
    const localization = await createEnglishLocalization(snapshot, model);
    const p = current.current;
    await commit({ ...p, output_locale: 'en', localizations: [...p.localizations.filter(item => !(item.locale === 'en' && item.snapshot_id === snapshot.id)), localization] });
    setNotice('現在の原作に対応する英訳を保存しました。漫画と動画字幕で共通利用します。');
  }
  async function selectOutputLocale(locale) {
    if (!['ja', 'en'].includes(locale)) throw Error('作品言語が不正です');
    await commit({ ...current.current, output_locale: locale });
    if (locale === 'en' && !currentEnglishLocalization(current.current, snapshot)) setNotice('英訳が未作成です。「英訳を作る」を実行してください。');
  }
  useEffect(() => {
    if (!ready || !desktop() || !snapshot?.repo || snapshot.repo !== repo) return;
    let disposed = false;
    async function check() {
      if (lock.current) return;
      try {
        const next = await syncSource(repo, token, episode, snapshot);
        if (!disposed && next.id !== snapshot.id) setPending(next);
      } catch { if (!disposed) setNotice('原作の自動更新確認は未完了です。ネット接続・トークンを確認するか、取得済みの版で制作できます。'); }
    }
    const startup = setTimeout(check, 1500);
    const timer = setInterval(check, 5 * 60 * 1000);
    return () => { disposed = true; clearTimeout(startup); clearInterval(timer); };
  }, [ready, repo, token, episode, snapshot?.id]);
  async function checkSync() { const s = await syncSource(repo, token, episode, snapshot); if (s.id === snapshot?.id) setNotice('原作は最新です'); else setPending(s); }
  async function applySync() {
    const p = current.current;
    const affected = snapshot ? affectedScenes(snapshot, pending) : [];
    const characters = mergeSourceReferences(p.characters, pending.references, pending.repo, pending.id);
    await commit({ ...p, title: pending.manifest.work, snapshots: p.snapshots.some(s => s.id === pending.id) ? p.snapshots : [...p.snapshots, pending], active: pending.id, characters });
    setNotice(`原作と基準画${pending.references.length}件を取り込みました。${affected.length ? `${affected.length}場面に変更があります。漫画にする操作で影響場面を更新します。` : '「漫画にする」で制作できます。'}`); setPending(null);
  }
  async function produce() {
    if (!snapshot) throw Error('まず原作を接続してください');
    let p = current.current;
    for (const scene of snapshot.scenes) {
      if (cancel.current) break;
      let scenePanels = p.panels.filter(x => x.sceneId === scene.id);
      const old = p.snapshots.find(s => s.id === scenePanels[0]?.snapshotId);
      if (!scenePanels.length || !old || affectedScenes(old, snapshot).includes(scene.id)) {
        setBusy(`${scene.id} の演出を設計中`);
        scenePanels = await planScene(scene, snapshot, p.characters, model);
        p = revise(p, [...p.panels.filter(x => x.sceneId !== scene.id), ...scenePanels], `${scene.id} の演出計画`);
        p.panels = snapshot.scenes.flatMap(s => p.panels.filter(x => x.sceneId === s.id)); await commit(p);
      }
      for (const panel of scenePanels) {
        if (cancel.current) break;
        if (panel.image) continue;
        if (productionMode === 'blender' && (!current.current.panels.find(p => p.id === panel.id)?.capture_revision || activeDirection(current.current, panel.id))) await stagePanel(panel.id);
        if (cancel.current) break;
        setBusy(`${scene.id} ・ ${panel.id} を作画中`);
        p = current.current;
        const livePanel = p.panels.find(x => x.id === panel.id);
        if (p.jobs.some(j => j.panelId === panel.id && j.status === 'unknown')) throw Error('応答未確定の制作要求があります。再実行前に結果を確認してください');
        const job = await beginJob(p, livePanel);
        p = { ...p, jobs: [...p.jobs, job] }; await commit(p);
        try {
          const generated = await generatePanel(livePanel, p.characters, null, '', job, p.captures?.find(c => c.id === livePanel.capture_revision), p.style_references ?? []);
          p = await commit(await finishJob(current.current, job, generated, cancel.current));
        } catch (e) { p = { ...current.current, jobs: current.current.jobs.map(j => j.id === job.id ? { ...j, status: 'unknown' } : j) }; await commit(p); throw e; }
      }
    }
    setNotice(cancel.current ? '停止しました。完成したコマは保存済みです。' : '作画が終了しました。人物・衣装・原作との整合を確認してください。');
  }
  async function stagePanel(panelId, instruction = '') {
    if (!model.connectionId) throw Error('先に演出AIの接続を登録・テストしてください');
    return directPanel({ current: () => current.current, commit, call, panelId, instruction,
      cancelled: () => cancel.current, notify: setBusy,
      ask: async (prompt, schema) => JSON.parse(await askLLM(model, { purpose: 'direction', prompt, schema })) });
  }
  async function directChosen() {
    if (!chosen) throw Error('コマを選択してください');
    await stagePanel(chosen.id, instruction.trim());
    if (!cancel.current) await drawChosen(chosen.id);
    setInstruction('');
  }
  async function drawChosen(panelId = selected) {
    const p = current.current, panel = p.panels.find(x => x.id === panelId);
    if (!panel) throw Error('対象コマを選択してください');
    const capture = p.captures?.find(c => c.id === panel.capture_revision);
    if (!capture) throw Error('先にBlenderで撮影してください');
    const job = await beginJob(p, panel, 'retake');
    await commit({ ...p, jobs: [...p.jobs, job] });
    try {
      const generated = await generatePanel(panel, p.characters, null, '', job, capture, p.style_references ?? []);
      await commit(await finishJob(current.current, job, generated, cancel.current, !!panel.image));
    } catch (e) {
      await commit({ ...current.current, jobs: current.current.jobs.map(j => j.id === job.id ? { ...j, status: 'unknown' } : j) }); throw e;
    }
  }
  async function addCharacter(file, style = false) {
    if (!style && !name.trim()) throw Error('人物名を入力してください');
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw Error('20MB以下のPNG/JPEG/WebPを選んでください');
    const bytes = await file.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const image = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const field = style ? 'style_references' : 'characters';
    await commit({ ...current.current, [field]: [...(current.current[field] ?? []), { id: crypto.randomUUID(), name: style ? (name.trim() || file.name) : name, description, image, hash, version: 1 }] }); setName(''); setDescription('');
  }
  async function edit() {
    if (!chosen || !instruction.trim()) throw Error('修正するコマと指示を指定してください');
    const route = editRoute(instruction);
    if (route.kind === 'readonly') throw Error('台詞本文はGitHub側で改訂し、再同期してください');
    if (route.kind === 'layout') throw Error('文字配置はページの組版設定から変更してください。画像AIは呼び出しません');
    if (['blender', 'camera'].includes(route.kind)) { await directChosen(); return; }
    const region = rect;
    if (!region) throw Error('画像をドラッグして修正範囲を指定してください');
    const job = await beginJob(current.current, chosen, 'edit');
    await commit({ ...current.current, jobs: [...current.current.jobs, job] });
    try {
      const next = await editRegion(chosen, project.characters, instruction, region, job, project.style_references ?? []);
      await commit(await finishJob(current.current, job, next, cancel.current));
    } catch (e) {
      await commit({ ...current.current, jobs: current.current.jobs.map(j => j.id === job.id ? { ...j, status: 'unknown' } : j) });
      throw e;
    } setInstruction(''); setRect(null);
  }
  async function sample() {
    if (project.snapshots.length) throw Error('作品を保護するためサンプルは空の状態でのみ開けます');
    const s = { id: 'sample', sha: 'sample', manifest: { work: '制作画面のサンプル' }, settings: [], scenes: [{ id: 'S01', text: '放課後の図書館。窓から光が差し込む。\n\n「ここ、空いてる？」\n\n彼女は顔を上げ、隣の椅子を引いた。\n\n「どうぞ」', design: '' }] };
    const ps = sourceUnits('S01', s.scenes[0].text).map((u, i) => ({ id: `S01:p${i}`, sceneId: 'S01', snapshotId: 'sample', unitIds: [u.id], prompt: 'Library scene', characterIds: [], image: null, status: 'planned', instructions: [], attempts: 0 }));
    await commit({ ...emptyProject(), title: s.manifest.work, snapshots: [s], active: s.id, panels: ps });
  }
  function point(e) { const box = e.currentTarget.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (e.clientY - box.top) / box.height))]; }
  return <div className="app"><header><div className="brand">M<span>↗</span></div><div><strong>Manga Mac</strong><small>原作から、漫画へ。</small></div><div className="spacer"/><span className="local">● {model.provider === 'ollama' ? 'Ollama接続' : '外部LLM接続'}</span><button disabled={!!busy || !ready} onClick={() => setSettings(!settings)}>接続・人物設定</button><button disabled={!!busy || !project.panels.length} onClick={() => run('書き出し中', async () => download(await exportCBZ(project), `manga-${project.output_locale}.cbz`))}>CBZを書き出す ↗</button></header>
    <div className="workspace"><aside><div className="aside-title">作品</div><h2>{project.title}</h2><p className="muted">{snapshot ? `原稿 ${snapshot.sha.slice(0, 8)}` : '原作未接続'} · {project.panels.length} コマ</p>{snapshot && <p className="muted source-contract">{contractLabel(snapshot)}</p>}<label className="production-mode">制作方法<select aria-label="制作方法" disabled={!!busy} value={productionMode} onChange={e => setProductionMode(e.target.value)}><option value="blender">Blenderで演出・作画</option><option value="direct">画像AIで直接作画</option></select></label><button className="primary full" disabled={!!busy || !snapshot || !desktop()} onClick={() => run('制作を開始', produce)}>✧ 漫画にする</button><div className="aside-title pages-label">ページ <span>{layout.pages.length}</span></div>{Array.from({ length: layout.pages.length }, (_, i) => <button className={`thumbnail ${page === i ? 'active' : ''}`} key={i} onClick={() => { setPage(i); setPagePreview(null); setSelected(null); setRect(null); }}><div className="mini-grid">{pagePanels(project,layout.pages[i]).map(p => <div key={p.id}>{p.image ? <img src={p.image}/> : <span>未作画</span>}</div>)}</div><span>PAGE {String(i + 1).padStart(2, '0')}</span></button>)}<div className="aside-bottom">本文と参照はそのままに。<br/>演出と作画を、この場所で。</div></aside>
    <main><div className="toolbar" aria-label="制作する媒体"><button aria-pressed={medium === 'manga'} disabled={!!busy} onClick={() => setMedium('manga')}>漫画</button><button aria-pressed={medium === 'video'} disabled={!!busy} onClick={() => setMedium('video')}>動画</button></div><div hidden={medium !== 'video'}>{busy && <div role="status" className="message progress">{busy}</div>}{error && <div role="alert" className="message error">{error}</div>}{notice && <div role="status" className="message">{notice}</div>}<VideoWorkspace project={project} current={current} commit={commit} run={run} busy={!!busy} notify={setNotice} model={model}/></div><div hidden={medium !== 'manga'}><div className="toolbar"><span>{project.panels.length ? `PAGE ${String(page + 1).padStart(2, '0')}` : '制作をはじめましょう'}</span><div className="spacer"/><label className="output-language">作品言語<select aria-label="作品言語" value={project.output_locale} disabled={!!busy || !ready} onChange={e => run('作品言語を変更', () => selectOutputLocale(e.target.value))}><option value="ja">日本語（原文）</option><option value="en">English</option></select></label>{project.output_locale === 'en' && <button disabled={!!busy || !snapshot} onClick={() => run(english ? '英訳を更新中' : '英訳を作成中', translateEnglish)}>{english ? '英訳を更新' : '英訳を作る'}</button>}<button disabled={!!busy || !project.history.length} onClick={() => run('元に戻す', async () => { const p = current.current, h = p.history.at(-1); await commit({ ...p, panels: h.panels, history: p.history.slice(0, -1) }); })}>↶ 元に戻す</button><button disabled={!!busy || !panels.length} onClick={() => run('PNGを書き出し', async () => { const data = await pagePNG(panels, project.snapshots, project.localizations, project.output_locale, pageData); await download(new Blob([Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0))], { type: 'image/png' }), `page-${page + 1}-${project.output_locale}.png`); })}>PNG</button></div>
    {panels.length > 0 && <div className="toolbar"><button disabled={!!busy} onClick={() => run('ページを確認中', async () => setPagePreview(await pagePNG(panels, project.snapshots, project.localizations, project.output_locale, pageData)))}>書き出しと同じページを確認</button>{pagePreview && <button onClick={() => setPagePreview(null)}>確認を閉じる</button>}</div>}
    {project.panels.length > 0 && <div className="toolbar"><button aria-pressed={layoutMode} disabled={!!busy} onClick={()=>{setLayoutMode(!layoutMode);setRect(null);}}>コマ割り編集</button><span>{layoutMode?'四隅・全体のドラッグ':'作画・局所修正'}</span></div>}
    {layoutMode && <LayoutEditor project={{...project,layout}} current={current} commit={commit} run={run} busy={!!busy} pageIndex={page} setPage={setPage} model={model} selected={selected} cancelled={()=>cancel.current}/>}
    {pagePreview && <img className="page-proof" src={pagePreview} alt="書き出しページの確認"/>}
    {error && <div role="alert" className="message error">{error}</div>}{notice && <div role="status" className="message">{notice}</div>}{busy && <div role="status" className="message progress">◌ {busy}<button onClick={() => { cancel.current = true; cancelLLMRequests().catch(() => setError('LLMの停止状態を確認できませんでした')); setNotice('LLMへ停止を要求しました。画像処理は現在のコマが終わったところで停止します'); }}>ここまでで停止</button></div>}
    {pending && <div className="message">原作 {pending.sha.slice(0, 8)}（{contractLabel(pending)}）を取得しました。{pending.scenes.length}場面・基準画{pending.references.length}件<button disabled={!!busy} onClick={() => run('新版を適用', applySync)}>この版を取り込む</button><button onClick={() => setPending(null)}>後で</button></div>}
    <div hidden={layoutMode}>{!panels.length ? <div className="welcome"><div className="welcome-icon">▤</div><h1>物語の、その先を描こう。</h1><p>完成した脚本と、キャラクターの参照画像。<br/>ふたつをつないで、最初のページをつくります。</p><button className="primary" onClick={() => setSettings(true)}>原作を接続する →</button>{!desktop() && <button disabled={!!busy || !ready} onClick={() => run('サンプルを開く', sample)}>画面のサンプルを見る</button>}<small>脚本はGitHubのmainと読み取り専用で同期します。</small></div> : <div className="page"><div className="panel-grid">{panels.map((p, i) => <article key={p.id} className={`panel ${selected === p.id ? 'selected' : ''}`} onClick={() => { if (selected !== p.id) { setSelected(p.id); setRect(null); } }}><div className="art" onPointerDown={e => { if (busy || !p.image) return; setSelected(p.id); drag.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); setRect(null); }} onPointerUp={e => { if (!drag.current) return; const end = point(e), start = drag.current; drag.current = null; const r = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1])]; if (r[2] > .01 && r[3] > .01) setRect(r); }}>{p.image ? <img draggable="false" src={p.image} alt={`コマ ${i + 1}`}/> : <div className="placeholder"><span>0{i + 1}</span><p>作画を待っています</p></div>}{selected === p.id && rect && <div className="region" style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }}/>}</div><div className={`caption ${project.output_locale === 'en' && !project.localizations.some(item => item.locale === 'en' && item.snapshot_id === p.snapshotId) ? 'missing-translation' : ''}`}>{panelText(p)}</div><div className="panel-meta">{p.sceneId} · {p.status === 'review' ? '見た目の確認待ち' : '演出計画'}</div></article>)}</div><div className="folio">{page + 1}</div></div>}
    </div>
    {chosen && !layoutMode && <LetteringControls key={`${chosen.id}:${project.revision}`} panel={chosen} current={current} commit={commit} run={run} busy={!!busy}/>}
    {chosen && <section className="shot-controls" aria-label="AI演出">
      <h3>このコマの演出</h3><p>下の欄に「勇の肩越しから」「もう少し寄って」などを入力してください。構図・演技の変更は撮影からやり直し、旧作画を残して候補を作ります。</p>
      <button disabled={!!busy || !desktop()} onClick={() => run('Blenderで演出中', directChosen)}>Blenderで演出して漫画化</button>
      {activeDirection(project, chosen.id) && <><p role="status">{activeDirection(project, chosen.id).message || '停止した演出があります。保存済みの結果を確認して再開します。'}</p>
        <button disabled={!!busy || !desktop()} onClick={() => run('演出を再開中', async () => { await stagePanel(chosen.id); if (!cancel.current) await drawChosen(chosen.id); })}>演出を再開</button>
        <button disabled={!!busy} onClick={() => run('演出を取り下げ', () => commit(abandonDirection(current.current, activeDirection(current.current, chosen.id).id)))}>演出を取り下げる</button>
      </>}
    </section>}
    <details className="shot-details"><summary>詳細調整・Blenderの保存結果を確認</summary>
    <ShotControls key={chosen?.id ?? `page-${page}`} project={project} current={current} commit={commit} panels={panels} chosen={chosen} busy={!!busy} run={run}/>
    </details>
    {chosen && <section className="shot-controls" aria-label="作画候補">
      <button disabled={!!busy || !chosen.capture_revision || !desktop()} onClick={() => run('撮影原本から漫画化中', () => drawChosen())}>撮影原本からこのコマを漫画化</button>
      {project.jobs.filter(j => j.panelId === chosen.id && ['candidate', 'unknown'].includes(j.status)).map(job => <div key={job.id}>
        <p>{job.status === 'unknown' ? '応答未確定：再実行する前に結果を確認してください' : '作画候補：採用前の原稿を保持しています'}</p>
        {job.status === 'unknown' && <button disabled={!!busy || !desktop()} onClick={() => run('保存済み作画を回収中', async () => { const receipt = await call('recover_image', { jobId: job.id }); await commit(await recoverImageResult(current.current, job.id, receipt)); setNotice('保存済み作画を候補として回収しました。再生成はしていません。'); })}>保存済み作画を回収する</button>}
        {job.output_revision && <><img className="shot-preview" src={project.artworks.find(a => a.id === job.output_revision)?.panel.image} alt="新しい作画候補"/><button disabled={!!busy} onClick={() => run('作画候補を採用中', async () => commit(await adoptCandidate(current.current, job.id)))}>この候補を採用</button></>}
        <button disabled={!!busy} onClick={() => run('要求を解決中', async () => commit(abandonJob(current.current, job.id)))}>採用せず解決する</button>
      </div>)}
    </section>}
    {!layoutMode && <div className="composer"><div className="scope">{chosen ? `選択中：${chosen.sceneId} ／ ${rect ? '指定領域だけを変更' : '部分修正はドラッグで範囲指定 ／ 構図・ポーズはBlenderで変更'}` : 'コマを選択して、気になるところを直す'}</div><div className="input-row"><input value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="もう少し照れた笑顔に。髪型と制服はそのままで。"/><button className="primary" disabled={!!busy || !chosen || (editRoute(instruction).kind === 'region' && (!chosen.image || !rect)) || !instruction.trim()} onClick={() => run('選択範囲を修正中', edit)}>修正する ↑</button></div><small>指定範囲の外側は元画像を保持します。台詞本文はGitHub側で変更してください。</small></div>}</div></main>
    {settings && <section className="settings"><div className="setting-head"><h2>制作の準備</h2><button onClick={() => setSettings(false)}>閉じる</button></div><h3>01 / 原作をつなぐ</h3><label>GitHubリポジトリ<input value={repo} onChange={e => setRepo(e.target.value)}/></label><label>話ID<input value={episode} onChange={e => setEpisode(e.target.value)} placeholder="P01"/></label><label>読み取り専用トークン<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)}/></label><small>トークンは今回の起動中だけ保持。原作リポジトリのContents: readを使用します。</small>{snapshot && <div className="source-status"><strong>使用中の原稿</strong><span>{snapshot.repo} / main @ {snapshot.sha.slice(0, 8)}</span><span>{contractLabel(snapshot)}</span></div>}<button className="full" disabled={!!busy || !ready} onClick={() => run('原作を取得中', checkSync)}>更新を確認する</button><h3>02 / キャラクターの正本</h3><small>原作のVISUAL設定に掲載された基準画は、原稿版を取り込むと同じcommitから自動登録されます。</small><div className="characters">{project.characters.map(c => <div key={c.id}><img src={c.image}/><span>{c.name}<small>v{c.version} · {c.hash.slice(0, 8)}{c.source ? ' · 原作連携' : ''}</small></span></div>)}</div><label>人物名<input value={name} onChange={e => setName(e.target.value)} placeholder="河合由美"/></label><label>固定する特徴<textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="髪型・体格・衣装など"/></label><label className="file">＋ 正本画像を登録<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy || !ready} onChange={e => { const file = e.target.files[0]; run('参照を登録', () => addCharacter(file)); e.target.value = ''; }}/></label><h3>画風参照</h3><div className="characters">{project.style_references?.map(style => <div key={style.id}><img src={style.image}/><span>{style.name}</span><button disabled={!!busy} onClick={() => run('画風参照を外す', async () => commit({ ...current.current, style_references: current.current.style_references.filter(s => s.id !== style.id) }))}>外す</button></div>)}</div><label className="file">＋ 画風参照を登録<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy || !ready} onChange={e => { const file = e.target.files[0]; run('画風参照を登録', () => addCharacter(file, true)); e.target.value = ''; }}/></label><h3>03 / AIの接続</h3><LLMSettings title="演出・コマ計画" value={model} onChange={setModel} disabled={!!busy} run={run} notify={setNotice}/><small>演出・コマ計画の接続は、漫画と動画で共通する英訳の作成にも使用します。</small><small>画像の作画はMac内のFLUXを使用します。</small><button disabled={!!busy} className="full" onClick={() => run('画像モデルを準備中（初回ダウンロード）', async () => { await call('prepare_engine'); setNotice('画像モデルの準備が完了しました'); })}>画像モデルを準備する</button><small>FLUX.2 klein 4B。初回はネット接続と十分な空き容量が必要です。Ollamaを選ぶ場合は別途起動してください。</small><h3>04 / Blenderで撮影する</h3><BlenderSettings project={project} disabled={!!busy} run={run} notify={setNotice}/><BackupSettings disabled={!!busy || !ready}/><h3>作品JSONの書き出し</h3><small>このJSONだけでは動画・Blender素材は復元できません。完全な復元にはクラウドバックアップを使用します。</small><button disabled={!ready || !!busy} onClick={() => run('作品をバックアップ', async () => { await download(new Blob([JSON.stringify(project)], { type: 'application/json' }), 'manga-project.json'); setNotice('作品JSONを書き出しました。Macではダウンロード / Manga Mac に保存されます。'); })}>作品データを書き出す</button></section>}
    </div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
