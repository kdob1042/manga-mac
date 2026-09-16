import { editRoute } from './edit-route';
import { recordCapture } from './shots';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { emptyProject, sourceForPanel, affectedScenes, revise, sourceUnits } from './core';
import { call, desktop, loadProject, saveProject } from './bridge';
import { syncSource, planScene, generatePanel, editRegion, locateFace } from './pipeline';
import { exportCBZ, pagePNG, download } from './render';
import './style.css';
import LLMSettings from './LLMSettings';
import { defaultConnection, cancelLLMRequests } from './llm';
import BlenderSettings from './BlenderSettings';
import ShotControls from './ShotControls';
import { loadLocale, saveLocale, translator } from './i18n';
import { beginJob, finishJob, adoptCandidate, abandonJob } from './revisions';

function App() {
  const [locale, setLocale] = useState(loadLocale), t = translator(locale);
  const [project, setProject] = useState(emptyProject), [ready, setReady] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [settings, setSettings] = useState(false);
  const [visionModel, setVisionModel] = useState(() => defaultConnection('ollama', true)), [target, setTarget] = useState('');
  const [repo, setRepo] = useState('kdob1042/Kamiya-Kawai'), [token, setToken] = useState(''), [episode, setEpisode] = useState('P01'), [model, setModel] = useState(() => defaultConnection());
  const [page, setPage] = useState(0), [selected, setSelected] = useState(null), [instruction, setInstruction] = useState(''), [pending, setPending] = useState(null), [rect, setRect] = useState(null), [name, setName] = useState(''), [description, setDescription] = useState('');
  const current = useRef(project), cancel = useRef(false), drag = useRef(null), lock = useRef(false);
  useEffect(() => { saveLocale(locale); document.documentElement.lang = locale; }, [locale]);
  useEffect(() => { loadProject().then(p => { if (p) { current.current = p; setProject(p); const s = p.snapshots.find(s => s.id === p.active); if (s?.repo) setRepo(s.repo); } setReady(true); }).catch(e => setError(t('loadFailed', { message: e.message }))); }, []);
  async function commit(p) { const saved = await saveProject({ ...p, revision: (current.current.revision ?? 0) + 1 }); current.current = saved; setProject(saved); return saved; }
  async function run(label, fn) { if (lock.current) return; lock.current = true; setBusy(label); setError(''); setNotice(''); cancel.current = false; try { await fn(); } catch (e) { setError(e.message ?? String(e)); } finally { setBusy(''); lock.current = false; } }
  const snapshot = project.snapshots.find(s => s.id === project.active), panels = project.panels.slice(page * 4, page * 4 + 4), chosen = project.panels.find(p => p.id === selected);
  useEffect(() => {
    if (!ready || !desktop() || !snapshot?.repo || snapshot.repo !== repo) return;
    let disposed = false;
    async function check() {
      if (lock.current) return;
      try {
        const next = await syncSource(repo, token, episode, snapshot);
        if (!disposed && next.id !== snapshot.id) setPending(next);
      } catch { if (!disposed) setNotice(t('sourceCheckIncomplete')); }
    }
    const startup = setTimeout(check, 1500);
    const timer = setInterval(check, 5 * 60 * 1000);
    return () => { disposed = true; clearTimeout(startup); clearInterval(timer); };
  }, [ready, repo, token, episode, snapshot?.id]);
  async function checkSync() { const s = await syncSource(repo, token, episode, snapshot); if (s.id === snapshot?.id) setNotice(t('sourceLatest')); else setPending(s); }
  async function applySync() {
    const p = current.current;
    const affected = snapshot ? affectedScenes(snapshot, pending) : [];
    await commit({ ...p, title: pending.manifest.work, snapshots: p.snapshots.some(s => s.id === pending.id) ? p.snapshots : [...p.snapshots, pending], active: pending.id });
    setNotice(affected.length ? t('sourceImportedChanged', { count: affected.length }) : t('sourceImported')); setPending(null);
  }
  async function produce() {
    if (!snapshot) throw Error(t('sourceRequired'));
    let p = current.current;
    for (const scene of snapshot.scenes) {
      if (cancel.current) break;
      let scenePanels = p.panels.filter(x => x.sceneId === scene.id);
      const old = p.snapshots.find(s => s.id === scenePanels[0]?.snapshotId);
      if (!scenePanels.length || !old || affectedScenes(old, snapshot).includes(scene.id)) {
        setBusy(t('planningScene', { scene: scene.id }));
        scenePanels = await planScene(scene, snapshot, p.characters, model);
        p = revise(p, [...p.panels.filter(x => x.sceneId !== scene.id), ...scenePanels], t('scenePlanLabel', { scene: scene.id }));
        p.panels = snapshot.scenes.flatMap(s => p.panels.filter(x => x.sceneId === s.id)); await commit(p);
      }
      for (const panel of scenePanels) {
        if (cancel.current) break;
        if (panel.image) continue;
        setBusy(t('drawingPanel', { scene: scene.id, panel: panel.id }));
        p = current.current;
        const livePanel = p.panels.find(x => x.id === panel.id);
        if (p.jobs.some(j => j.panelId === panel.id && j.status === 'unknown')) throw Error(t('unknownRequest'));
        const job = await beginJob(p, livePanel);
        p = { ...p, jobs: [...p.jobs, job] }; await commit(p);
        try {
          const generated = await generatePanel(livePanel, p.characters, null, '', job, p.captures?.find(c => c.id === livePanel.capture_revision), p.style_references ?? []);
          p = await commit(await finishJob(current.current, job, generated, cancel.current));
        } catch (e) { p = { ...current.current, jobs: current.current.jobs.map(j => j.id === job.id ? { ...j, status: 'unknown' } : j) }; await commit(p); throw e; }
      }
    }
    setNotice(cancel.current ? t('stopped') : t('drawingComplete'));
  }
  async function drawChosen() {
    const p = current.current, panel = p.panels.find(x => x.id === selected);
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
    if (!style && !name.trim()) throw Error(t('characterNameRequired'));
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw Error(t('imageRequirements'));
    const bytes = await file.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const image = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const field = style ? 'style_references' : 'characters';
    await commit({ ...current.current, [field]: [...(current.current[field] ?? []), { id: crypto.randomUUID(), name: style ? (name.trim() || file.name) : name, description, image, hash, version: 1 }] }); setName(''); setDescription('');
  }
  async function edit() {
    if (!chosen || !instruction.trim()) throw Error(t('editSelectionRequired'));
    const route = editRoute(instruction);
    if (route.kind === 'readonly') throw Error(t('dialogueReadonly'));
    if (route.kind === 'layout') throw Error('文字配置はページの組版設定から変更してください。画像AIは呼び出しません');
    if (route.kind === 'blender') throw Error('この3D操作はBlenderで調整し、対象コマへScene・Camera・フレームを指定してください');
    if (route.kind === 'camera') {
      if (!chosen.shot_binding) throw Error('このコマにBlenderショットを割り当ててください');
      const state = await call('blender_status', { sessionId: chosen.shot_binding.session_id });
      const lens = route.lens ?? Math.max(10, Math.min(250, state.state.state.lens * route.factor));
      const camera = await call('blender_execute', { request: { session_id: state.session_id, request_id: crypto.randomUUID(), expected_revision: state.revision, operation: { kind: 'camera', lens } } });
      const resolution = current.current.captures?.find(c => c.id === chosen.capture_revision)?.settings.resolution ?? [768, 768];
      const capture = await call('blender_execute', { request: { session_id: state.session_id, request_id: crypto.randomUUID(), expected_revision: camera.revision, operation: { kind: 'capture', width: resolution[0], height: resolution[1] } } });
      await commit(await recordCapture(current.current, chosen.id, capture));
      await drawChosen(); setInstruction(''); setRect(null); return;
    }
    let region = rect;
    if (!region) { const character = project.characters.find(c => c.id === target && chosen.characterIds.includes(c.id)); if (!character) throw Error(t('faceOrRegionRequired')); setBusy(t('locatingFace')); region = await locateFace(chosen, character, visionModel); setRect(region); setNotice('完成画像上の修正範囲を確認し、もう一度「修正」を押してください'); return; }
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
    if (project.snapshots.length) throw Error(t('sampleProtected'));
    const s = { id: 'sample', sha: 'sample', manifest: { work: t('sampleTitle') }, settings: [], scenes: [{ id: 'S01', text: t('sampleText'), design: '' }] };
    const ps = sourceUnits('S01', s.scenes[0].text).map((u, i) => ({ id: `S01:p${i}`, sceneId: 'S01', snapshotId: 'sample', unitIds: [u.id], prompt: t('samplePrompt'), characterIds: [], image: null, status: 'planned', instructions: [], attempts: 0 }));
    await commit({ ...emptyProject(), title: s.manifest.work, snapshots: [s], active: s.id, panels: ps });
  }
  function point(e) { const box = e.currentTarget.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (e.clientY - box.top) / box.height))]; }
  return <div className="app"><header><div className="brand">M<span>↗</span></div><div><strong>Manga Mac</strong><small>{t('appTagline')}</small></div><div className="spacer"/><span className="local">● {model.provider === 'ollama' && visionModel.provider === 'ollama' ? t('localAI') : t('externalLLM')}</span><label className="language"><span>{t('language')}</span><select aria-label={t('language')} value={locale} onChange={e => setLocale(e.target.value)}><option value="ja">{t('japanese')}</option><option value="en">{t('english')}</option></select></label><button disabled={!!busy || !ready} onClick={() => setSettings(!settings)}>{t('settings')}</button><button disabled={!!busy || !project.panels.length} onClick={() => run(t('exporting'), async () => download(await exportCBZ(project), 'manga.cbz'))}>{t('exportCBZ')}</button></header>
    <div className="workspace"><aside><div className="aside-title">{t('work')}</div><h2>{project.title}</h2><p className="muted">{snapshot?.sha?.slice(0, 8) ?? t('sourceDisconnected')} · {t('panelCount', { count: project.panels.length })}</p><button className="primary full" disabled={!!busy || !snapshot || !desktop()} onClick={() => run(t('startProduction'), produce)}>{t('makeManga')}</button><div className="aside-title pages-label">{t('pages')} <span>{Math.ceil(project.panels.length / 4)}</span></div>{Array.from({ length: Math.ceil(project.panels.length / 4) }, (_, i) => <button className={`thumbnail ${page === i ? 'active' : ''}`} key={i} onClick={() => { setPage(i); setSelected(null); setRect(null); }}><div className="mini-grid">{project.panels.slice(i * 4, i * 4 + 4).map(p => <div key={p.id}>{p.image ? <img src={p.image}/> : <span>{t('unrendered')}</span>}</div>)}</div><span>PAGE {String(i + 1).padStart(2, '0')}</span></button>)}<div className="aside-bottom">{t('sourcePromise')}<br/>{t('directionPromise')}</div></aside>
    <main><div className="toolbar"><span>{project.panels.length ? `PAGE ${String(page + 1).padStart(2, '0')}` : t('startCreating')}</span><div className="spacer"/><button disabled={!!busy || !project.history.length} onClick={() => run(t('undoing'), async () => { const p = current.current, h = p.history.at(-1); await commit({ ...p, panels: h.panels, history: p.history.slice(0, -1) }); })}>{t('undo')}</button><button disabled={!!busy || !panels.length} onClick={() => run(t('exportingPNG'), async () => { const data = await pagePNG(panels, project.snapshots); await download(new Blob([Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0))], { type: 'image/png' }), `page-${page + 1}.png`); })}>PNG</button></div>
    {error && <div role="alert" className="message error">{error}</div>}{notice && <div role="status" className="message">{notice}</div>}{busy && <div role="status" className="message progress">◌ {busy}<button onClick={() => { cancel.current = true; cancelLLMRequests().catch(() => setError(t('stopStatusFailed'))); setNotice(t('stopRequested')); }}>{t('stopHere')}</button></div>}
    {pending && <div className="message">{t('sourceUpdate', { sha: pending.sha.slice(0, 8), count: pending.scenes.length })}<button disabled={!!busy} onClick={() => run(t('sourceApplied'), applySync)}>{t('applyVersion')}</button><button onClick={() => setPending(null)}>{t('later')}</button></div>}
    {!panels.length ? <div className="welcome"><div className="welcome-icon">▤</div><h1>{t('welcomeTitle')}</h1><p>{t('welcomeBody').split('\n').map((line, index) => <React.Fragment key={line}>{index > 0 && <br/>}{line}</React.Fragment>)}</p><button className="primary" onClick={() => setSettings(true)}>{t('connectSource')}</button>{!desktop() && <button disabled={!!busy || !ready} onClick={() => run(t('viewSample'), sample)}>{t('viewSample')}</button>}<small>{t('readonlySync')}</small></div> : <div className="page"><div className="panel-grid">{panels.map((p, i) => <article key={p.id} className={`panel ${selected === p.id ? 'selected' : ''}`} onClick={() => { if (selected !== p.id) { setSelected(p.id); setRect(null); } }}><div className="art" onPointerDown={e => { if (busy || !p.image) return; setSelected(p.id); drag.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); setRect(null); }} onPointerUp={e => { if (!drag.current) return; const end = point(e), start = drag.current; drag.current = null; const r = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1])]; if (r[2] > .01 && r[3] > .01) setRect(r); }}>{p.image ? <img draggable="false" src={p.image} alt={t('panelAlt', { number: i + 1 })}/> : <div className="placeholder"><span>0{i + 1}</span><p>{t('waitingForArt')}</p></div>}{selected === p.id && rect && <div className="region" style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }}/>}</div><div className="caption">{sourceForPanel(p, project.snapshots.find(s => s.id === p.snapshotId))}</div><div className="panel-meta">{p.sceneId} · {p.status === 'review' ? t('visualReview') : t('directionPlan')}</div></article>)}</div><div className="folio">{page + 1}</div></div>}
    <ShotControls key={chosen?.id ?? `page-${page}`} project={project} current={current} commit={commit} panels={panels} chosen={chosen} busy={!!busy} run={run}/>
    {chosen && <section className="shot-controls" aria-label="作画候補">
      <button disabled={!!busy || !chosen.capture_revision || !desktop()} onClick={() => run('撮影原本から漫画化中', drawChosen)}>撮影原本からこのコマを漫画化</button>
      {project.jobs.filter(j => j.panelId === chosen.id && ['candidate', 'unknown'].includes(j.status)).map(job => <div key={job.id}>
        <p>{job.status === 'unknown' ? '応答未確定：再実行する前に結果を確認してください' : '作画候補：採用前の原稿を保持しています'}</p>
        {job.output_revision && <><img className="shot-preview" src={project.artworks.find(a => a.id === job.output_revision)?.panel.image} alt="新しい作画候補"/><button disabled={!!busy} onClick={() => run('作画候補を採用中', async () => commit(await adoptCandidate(current.current, job.id)))}>この候補を採用</button></>}
        <button disabled={!!busy} onClick={() => run('要求を解決中', async () => commit(abandonJob(current.current, job.id)))}>採用せず解決する</button>
      </div>)}
    </section>}
    <div className="composer"><div className="scope">{chosen ? rect ? t('selectedRegion', { scene: chosen.sceneId }) : t('selectedFace', { scene: chosen.sceneId }) : t('choosePanel')}</div><div className="input-row">{chosen?.characterIds.length > 0 && <select aria-label={t('faceCharacter')} value={target} onChange={e => setTarget(e.target.value)}><option value="">{t('faceCharacter')}</option>{chosen.characterIds.map(id => <option key={id} value={id}>{project.characters.find(c => c.id === id)?.name ?? id}</option>)}</select>}<input value={instruction} onChange={e => setInstruction(e.target.value)} placeholder={t('editPlaceholder')}/><button className="primary" disabled={!!busy || !chosen?.image || (editRoute(instruction).kind === 'region' && !rect && !chosen?.characterIds.includes(target)) || !instruction.trim()} onClick={() => run(t('editingRegion'), edit)}>{t('revise')}</button></div><small>{t('editHint')}</small></div></main>
    {settings && <section className="settings"><div className="setting-head"><h2>{t('setup')}</h2><button onClick={() => setSettings(false)}>{t('close')}</button></div><h3>{t('sourceSection')}</h3><label>{t('repository')}<input value={repo} onChange={e => setRepo(e.target.value)}/></label><label>{t('episodeId')}<input value={episode} onChange={e => setEpisode(e.target.value)} placeholder="P01"/></label><label>{t('readonlyToken')}<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)}/></label><small>{t('tokenHint')}</small><button className="full" disabled={!!busy || !ready} onClick={() => run(t('fetchingSource'), checkSync)}>{t('checkUpdates')}</button><h3>{t('characterSection')}</h3><div className="characters">{project.characters.map(c => <div key={c.id}><img src={c.image}/><span>{c.name}<small>v{c.version} · {c.hash.slice(0, 8)}</small></span></div>)}</div><label>{t('characterName')}<input value={name} onChange={e => setName(e.target.value)} placeholder={t('characterNamePlaceholder')}/></label><label>{t('fixedTraits')}<textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t('traitsPlaceholder')}/></label><label className="file">{t('addMasterImage')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy || !ready} onChange={e => { const file = e.target.files[0]; run(t('registeringReference'), () => addCharacter(file)); e.target.value = ''; }}/></label><h3>画風参照</h3><div className="characters">{project.style_references?.map(style => <div key={style.id}><img src={style.image}/><span>{style.name}</span><button disabled={!!busy} onClick={() => run('画風参照を外す', async () => commit({ ...current.current, style_references: current.current.style_references.filter(s => s.id !== style.id) }))}>外す</button></div>)}</div><label className="file">＋ 画風参照を登録<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy || !ready} onChange={e => { const file = e.target.files[0]; run('画風参照を登録', () => addCharacter(file, true)); e.target.value = ''; }}/></label><h3>{t('aiSection')}</h3><LLMSettings t={t} title={t('planning')} value={model} onChange={setModel} disabled={!!busy} run={run} notify={setNotice}/><LLMSettings t={t} title={t('faceDetection')} value={visionModel} onChange={setVisionModel} vision disabled={!!busy} run={run} notify={setNotice}/><small>{t('localImageHint')}</small><button disabled={!!busy} className="full" onClick={() => run(t('preparingModel'), async () => { await call('prepare_engine'); setNotice(t('modelReady')); })}>{t('prepareImageModel')}</button><small>{t('imageModelHint')}</small><h3>{t('blenderSection')}</h3><BlenderSettings t={t} disabled={!!busy} run={run} notify={setNotice}/><h3>{t('backup')}</h3><button disabled={!ready || !!busy} onClick={() => run(t('backingUp'), async () => { await download(new Blob([JSON.stringify(project)], { type: 'application/json' }), 'manga-project.json'); setNotice(t('backupComplete')); })}>{t('exportProject')}</button></section>}
    </div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
