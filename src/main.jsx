import {producePanels} from './production.js';
import { openLiveShot } from './live-blender';
import {finalizeProducedSource} from './source-patch.js';
import {createProjectWriter} from './project-writer.js';
import {sourceSummary} from './source-sync.js';
import SourceLibrary from './SourceLibrary.jsx';
import { produceDraft } from './production.js';
import {recognizeRegions,regionForEdit} from './visual-regions';
import EditProposals from './EditProposals';
import DraftControls from './DraftControls';
import { panelAction, checkPanelAction } from './panel-actions';
import { classifyEdit } from './jev';
import { editContext, editBase, planEdit, undoEdit, saveEditProposal, loadEditProposal, resolveEditProposal, executeEditSequence, commands } from './edit-commands';
import { draftPageStatus, preserveDraft } from './draft';
import PanelMotionControls from './PanelMotionControls';
import { exportLiveManga } from './live-export';
import { pagePanels, ensureLayout } from './layout.js';
import { directPanel, activeDirection, abandonDirection } from './directing';
import { askLLM } from './llm';
import LetteringControls from './LetteringControls';
import { editRoute } from './edit-route';
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
const CompositorControls = React.lazy(() => import('./CompositorControls'));
const LayeredControls = React.lazy(() => import('./LayeredControls'));
import { emptyProject, panelHasText, affectedScenes, sourceUnits } from './core';
import { call, desktop, loadProject, saveProject } from './bridge';
import { syncSource, planScene, generatePanel, editRegion } from './pipeline';
import { exportCBZ, download } from './export.js';
import { pagePNG } from './render.js';
import { imageOf } from './canvas-image.js';
import UpscaleControls from './UpscaleControls.jsx';
import FinishingControls from './FinishingControls.jsx';
import './style.css';
import { defaultConnection, cancelLLMRequests } from './llm';
import { useBackupSchedule } from './useBackupSchedule.js';
import ShotControls from './ShotControls';
import { recoverImageResult } from './image-recovery';
import { beginJob, finishJob, adoptCandidate, abandonJob } from './revisions';
import { createEnglishLocalization, currentEnglishLocalization, textForPanel } from './localization';
import { protocolLabel, mergeSourceReferences } from './source-protocol';
import { fetchStoryLibrary, fetchStoryLibraryWork, findLibraryWork, DEFAULT_STORY_LIBRARY_REPO } from './story-library.js';
import { defaultImageModelId, imageModel } from './media.js';

const SettingsPanel = lazy(() => import('./SettingsPanel.jsx'));
const VideoWorkspace = lazy(() => import('./VideoWorkspace.jsx'));
const SectionCompletion = lazy(() => import('./SectionCompletion.jsx'));
const LivePreviewControls = lazy(() => import('./LivePreviewControls.jsx'));
const LayoutEditor = lazy(() => import('./LayoutEditor.jsx'));
const ContentReplan = lazy(() => import('./ContentReplan.jsx'));
const SourceUpdate = lazy(() => import('./SourceUpdate.jsx'));

// Open on demand, then retain inputs and unfinished proposals between stages.
function StagePane({active, children, ...props}) {
  const visited = useRef(false);
  if (active) visited.current = true;
  return <section {...props} hidden={!active}>{visited.current ? <Suspense fallback={<p role="status" className="stage-hint">作業画面を読み込み中…</p>}>{children}</Suspense> : null}</section>;
}

function App() {
  const [library,setLibrary]=useState(null), [libraryCatalog,setLibraryCatalog]=useState(null), [selectedWorkId,setSelectedWorkId]=useState(''), [selectedSceneId,setSelectedSceneId]=useState(''), [selectedEpisodeIds,setSelectedEpisodeIds]=useState([]), [sourceBranch,setSourceBranch]=useState('main');
  const [jev,setJev]=useState(null),[editCandidate,setEditCandidate]=useState(null),[autoApply,setAutoApply]=useState(false);
  const [requestedShot, setRequestedShot] = useState(null), [requestedPairId, setRequestedPairId] = useState(null), [requestedVideoPanels, setRequestedVideoPanels] = useState([]);
  const [stage,setStage] = useState('source');
  const [loadAttempt,setLoadAttempt] = useState(0), [loadError,setLoadError] = useState('');
  const [batchPanels,setBatchPanels]=useState([]);
  const [productionMode, setProductionMode] = useState('direct');
  const [medium, setMedium] = useState('manga');
  const [videoOpened, setVideoOpened] = useState(false);
  useEffect(() => { if (medium === 'video') setVideoOpened(true); }, [medium]);
  const [project, setProject] = useState(emptyProject), [ready, setReady] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [settings, setSettings] = useState(false), [pagePreview, setPagePreview] = useState(null);
  const [repo, setRepo] = useState(DEFAULT_STORY_LIBRARY_REPO), [token, setToken] = useState(''), [episode, setEpisode] = useState('P01'), [model, setModel] = useState(() => defaultConnection()), [imageModelId, setImageModelId] = useState(defaultImageModelId);
  const [page, setPage] = useState(0), [selected, setSelected] = useState(null), [instruction, setInstruction] = useState(''), [pending, setPending] = useState(null), [rect, setRect] = useState(null), [name, setName] = useState(''), [description, setDescription] = useState('');
  useBackupSchedule(ready, !!busy);
  const current = useRef(project), cancel = useRef(false), drag = useRef(null), lock = useRef(false);
  function restoreSourceSelection(loaded, lib = null) {
    const saved = loaded.snapshots.find(item => item.id === loaded.active);
    const entry = lib?.entries.find(item => item.id === lib.active);
    if (entry?.repo || saved?.repo) setRepo(entry?.repo ?? saved.repo);
    setEpisode(entry?.episode ?? loaded.sourceSelection?.episodeId ?? saved?.episodeId ?? 'P01');
    setSelectedWorkId(entry?.work_id ?? loaded.workId ?? saved?.workId ?? '');
    setSelectedSceneId(entry?.scene ?? loaded.sourceSelection?.sceneId ?? saved?.selectedSceneId ?? '');
  }
  function restoreSourceLibrary(lib, loaded = current.current) {
    setLibrary(lib);
    restoreSourceSelection(loaded, lib);
  }
  useEffect(() => { let stopped = false; setLoadError(''); loadProject().then(async p => {
    if (stopped) return;
    const loaded = p ?? emptyProject();
    current.current = loaded; setProject(loaded);
    setStage(loaded.panels.length ? 'art' : 'source');
    setImageModelId(loaded.mediaDefaults?.image ?? defaultImageModelId);
    const s = loaded.snapshots.find(item => item.id === loaded.active);
    restoreSourceSelection(loaded);
    if (desktop()) {
      let lib;
      try { lib = await call('source_library'); }
      catch (e) { if (!stopped) setNotice(`原稿一覧を読み込めませんでした。保存済み作品は編集できます。${e.message ?? e}`); }
      if (stopped) return;
      if (lib) restoreSourceLibrary(lib, loaded);
    }
    setSourceBranch(loaded.sourceSelection?.branch ?? s?.sync?.source_branch ?? 'main');
    setSelectedEpisodeIds(loaded.sourceSelection?.episodeIds ?? s?.episodeIds ?? (s?.episodeId ? [s.episodeId] : []));
    showScene(loaded,loaded.sourceSelection?.sceneId);
    setReady(true);
  }).catch(e => { if (!stopped) setLoadError(`保存作品を読み込めません: ${e.message}`); }); return () => { stopped = true; }; }, [loadAttempt]);
  const writer=useRef(null);if(!writer.current)writer.current=createProjectWriter({current:()=>current.current,save:saveProject,accept:p=>{current.current=p;setProject(p);setPagePreview(null);}});
  function commit(p) { return writer.current.commit(p); }
  async function run(label, fn) { if (lock.current) return; lock.current = true; setBusy(label); setError(''); setNotice(''); cancel.current = false; try { await fn(); } catch (e) { setError(e.message ?? String(e)); } finally { setBusy(''); lock.current = false; } }
  const snapshot = project.snapshots.find(s => s.id === project.active);
  const layout = useMemo(() => project.layout ?? ensureLayout(project).layout, [project]);
  const layoutProject = useMemo(() => project.layout === layout ? project : {...project,layout}, [project,layout]);
  const pageData = layout.pages[page];
  const panels = useMemo(() => pagePanels(project,pageData), [project,pageData]);
  const chosen = project.panels.find(p => p.id === selected);
  useEffect(() => { if (page >= layout.pages.length) setPage(Math.max(0,layout.pages.length-1)); }, [page,layout.pages.length]);
  useEffect(() => {
    if (stage !== 'finish' || medium !== 'manga' || !panels.length) return;
    let stopped = false;
    pagePNG(panels, project.snapshots, project.localizations, project.output_locale, pageData, false, layout.imageCrops)
      .then(image => { if (!stopped) setPagePreview(image); })
      .catch(e => { if (!stopped) setError(`仕上がりを表示できません: ${e.message}`); });
    return () => { stopped = true; };
  }, [stage,medium,panels,project.snapshots,project.localizations,project.output_locale,pageData,layout.imageCrops]);
  const pagePanelKey=panels.map(panel=>panel.id).join('|');
  useEffect(()=>setBatchPanels(ids=>ids.filter(id=>panels.some(panel=>panel.id===id))),[pagePanelKey]);
  const english = currentEnglishLocalization(project, snapshot);
  function panelText(panel) {
    if(!panelHasText(panel))return '';
    const panelSnapshot = project.snapshots.find(s => s.id === panel.snapshotId);
    if (project.output_locale !== 'en') return textForPanel(panel, panel.sourceRefs?project.snapshots:panelSnapshot);
    const localization = project.localizations.find(item => item.locale === 'en' && item.snapshot_id === panel.snapshotId);
    return localization ? textForPanel(panel, panel.sourceRefs?project.snapshots:panelSnapshot, panel.sourceRefs?project.localizations:localization) : '英訳未作成';
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
  async function refreshLibraryCatalog() {
    const loaded = await fetchStoryLibrary(DEFAULT_STORY_LIBRARY_REPO, token, call, sourceBranch);
    const entry = library?.entries.find(item => item.id === library.active);
    const workId = entry?.work_id ?? current.current.workId ?? '';
    if (workId) {
      const detail = await fetchStoryLibraryWork(loaded, workId, token, call);
      setLibraryCatalog({...loaded,...detail});
      setSelectedWorkId(workId);
      const available=detail.outline.map(item=>item.id);
      const browse=available.includes(entry?.episode) ? entry.episode : (detail.outline[0]?.id ?? 'P01');
      const browseItem=detail.outline.find(item=>item.id===browse);
      setEpisode(browse);
      setSelectedSceneId(browseItem?.scenes.some(scene=>scene.id===entry?.scene) ? entry.scene : (browseItem?.scenes[0]?.id ?? ''));
      const kept=selectedEpisodeIds.filter(id=>available.includes(id));
      setSelectedEpisodeIds(kept.length ? kept : [browse]);
    } else {
      setLibraryCatalog(loaded);
    }
    setNotice(`原稿一覧を更新しました（${loaded.catalog.works.length}作品、${loaded.branch} @${loaded.sha.slice(0,8)}）。作品を選択してください。`);
  }
  function showScene(p,sceneId){
    const panel=p.panels.find(panel=>panel.sceneId===sceneId||(panel.sourceRefs??[]).some(r=>r.sceneId===sceneId));
    const index=p.layout?.pages.findIndex(page=>page.slots.some(slot=>slot.panelId===panel?.id))??-1;
    setSelected(panel?.id??null);setRect(null);if(index>=0)setPage(index);
  }
  async function persistLibrarySelection(work, detail, episodeId, sceneId, id) {
    const result=await call('source_register',{
      name:work.title, repo:detail.repo, episode:episodeId, id,
      workId:work.id, workRoot:work.root, manifestPath:detail.entryPath,
      catalogCommit:detail.sha, scene:sceneId, format:work.manuscriptFormat,
    });
    setLibrary(previous=>previous ? {...previous,entries:result.entries,active:result.id} : previous);
    return result;
  }
  async function selectLibraryWork(workId) {
    setPending(null);
    if (!libraryCatalog) throw Error('先に原稿一覧を更新してください');
    const detail=await fetchStoryLibraryWork(libraryCatalog,workId,token,call);
    const work=detail.work;
    if (!work.formats.includes('manga')) throw Error('選択作品は漫画制作対象ではありません');
    const first=detail.outline[0], firstScene=detail.outline[0]?.scenes[0];
    if (!first || !firstScene) throw Error('選択作品に話・シーンがありません');
    const entry=library?.entries.find(item=>item.id===library.active);
    const sameWork=entry?.work_id===work.id && entry?.repo===detail.repo;
    const existingWorkEntry=library?.entries.find(item=>item.work_id===work.id && item.repo===detail.repo);
    const hasContent=['snapshots','panels','artworks','characters','style_references','history','jobs','localizations','captures','videoShots','videoRevisions','videoHistory'].some(key=>Array.isArray(current.current[key])&&current.current[key].length>0)||current.current.layout?.pages?.length>0;
    const canReuseEmptyEntry=!!entry&&!entry.work_id&&entry.repo?.toLowerCase()===detail.repo.toLowerCase()&&!hasContent;
    const workspaceId=sameWork ? entry.id : (existingWorkEntry?.id ?? (canReuseEmptyEntry ? entry.id : null));
    const result=await persistLibrarySelection(work,detail,first.id,firstScene.id,workspaceId);
    setLibraryCatalog({...detail}); setSelectedWorkId(work.id); setEpisode(first.id); setSelectedSceneId(firstScene.id); setSelectedEpisodeIds([first.id]);
    if (result.id !== library?.active) { await call('backup_open',{workspace:result.id}); return; }
    await commit({...current.current,workId:work.id,sourceSelection:{workId:work.id,episodeId:first.id,sceneId:firstScene.id,episodeIds:[first.id],branch:sourceBranch}});
  }
  async function selectLibraryEpisode(episodeId) {
    setPending(null);
    const work=findLibraryWork(libraryCatalog?.catalog,selectedWorkId), detail=libraryCatalog;
    const item=detail?.outline?.find(episodeItem=>episodeItem.id===episodeId);
    const scene=item?.scenes[0];
    if (!work||!detail?.entryPath||!item||!scene) throw Error('話の選択対象が不正です');
    const entry=library?.entries.find(currentEntry=>currentEntry.id===library.active);
    if (!entry||entry.work_id!==work.id) throw Error('先に作品を選択してください');
    await persistLibrarySelection(work,detail,episodeId,scene.id,entry.id);
    setEpisode(episodeId); setSelectedSceneId(scene.id);showScene(current.current,scene.id);
    await commit({...current.current,workId:work.id,sourceSelection:{...current.current.sourceSelection,workId:work.id,episodeId,sceneId:scene.id,episodeIds:selectedEpisodeIds,branch:sourceBranch}});
  }
  async function selectLibraryScene(sceneId) {
    setPending(null);
    const work=findLibraryWork(libraryCatalog?.catalog,selectedWorkId), detail=libraryCatalog;
    const item=detail?.outline?.find(episodeItem=>episodeItem.id===episode);
    if (!work||!detail?.entryPath||!item?.scenes.some(scene=>scene.id===sceneId)) throw Error('シーンの選択対象が不正です');
    const entry=library?.entries.find(currentEntry=>currentEntry.id===library.active);
    if (!entry||entry.work_id!==work.id) throw Error('先に作品を選択してください');
    await persistLibrarySelection(work,detail,episode,sceneId,entry.id);
    setSelectedSceneId(sceneId);showScene(current.current,sceneId);
    await commit({...current.current,workId:work.id,sourceSelection:{...current.current.sourceSelection,workId:work.id,episodeId:episode,sceneId,episodeIds:selectedEpisodeIds,branch:sourceBranch}});
  }
  function toggleImportEpisode(id,checked) {
    return run('取込範囲を保存',async()=>{
      const available=libraryCatalog?.outline?.map(item=>item.id)??[];
      if(!available.includes(id))throw Error('取込対象の話が変わりました');
      const next=checked?[...new Set([...selectedEpisodeIds,id])]:selectedEpisodeIds.filter(item=>item!==id);
      setSelectedEpisodeIds(next);setPending(null);
      await commit({...current.current,sourceSelection:{...current.current.sourceSelection,workId:selectedWorkId||current.current.workId,episodeId:episode,sceneId:selectedSceneId,episodeIds:next,branch:sourceBranch}});
    });
  }
  function selectImportEpisodes(all) {
    return run('取込範囲を保存',async()=>{
      const next=all?(libraryCatalog?.outline?.map(item=>item.id)??[]):[episode];
      setSelectedEpisodeIds(next);setPending(null);
      await commit({...current.current,sourceSelection:{...current.current.sourceSelection,workId:selectedWorkId||current.current.workId,episodeId:episode,sceneId:selectedSceneId,episodeIds:next,branch:sourceBranch}});
    });
  }
  async function changeSourceBranch(branch) {
    if(!['dev','main'].includes(branch))throw Error('原稿ブランチはdevまたはmainを選んでください');
    setSourceBranch(branch);setLibraryCatalog(null);setPending(null);
    await commit({...current.current,sourceSelection:{...current.current.sourceSelection,workId:selectedWorkId||current.current.workId,episodeId:episode,sceneId:selectedSceneId,episodeIds:selectedEpisodeIds,branch}});
    setNotice(`原稿ブランチを${branch}へ変更しました。一覧または更新確認で最新HEADを取得します。`);
  }
  async function checkSync() {
    setPending(null);
    try {
      const entry=library?.entries.find(item=>item.id===library.active);
      let libraryOptions={branch:sourceBranch,episodeIds:[episode]};
      if(entry?.work_id){
        const loaded=await fetchStoryLibrary(entry.repo||DEFAULT_STORY_LIBRARY_REPO,token,call,sourceBranch);
        const detail=await fetchStoryLibraryWork(loaded,entry.work_id,token,call);
        setLibraryCatalog({...loaded,...detail});
        const available=new Set(detail.outline.map(item=>item.id));
        const requested=(selectedEpisodeIds.length?selectedEpisodeIds:[episode]).filter(id=>available.has(id));
        if(!requested.length||requested.length!==(selectedEpisodeIds.length?selectedEpisodeIds:[episode]).length)throw Error('取り込む話を選び直してください');
        const selectedScene=requested.length===1&&requested[0]===episode ? (selectedSceneId||entry.scene) : null;
        const saved=await call('source_register',{
          name:detail.work.title,repo:detail.repo,episode,id:entry.id,workId:entry.work_id,workRoot:detail.work.root,
          manifestPath:detail.entryPath,catalogCommit:detail.sha,scene:selectedSceneId||entry.scene,format:detail.work.manuscriptFormat,
        });
        setLibrary({...library,entries:saved.entries});
        libraryOptions={
          commit:detail.sha,branch:sourceBranch,workId:entry.work_id,workRoot:detail.work.root,sourceRoot:detail.sourceRoot,
          manifestPath:detail.entryPath,episodeIds:requested,...(selectedScene?{sceneId:selectedScene}:{}),format:detail.work.manuscriptFormat,
        };
      } else if(library && entry) {
        const saved=await call('source_register',{name:entry.name,repo:entry.repo,episode,id:entry.id});
        setLibrary({...library,entries:saved.entries});
      }
      const next=await syncSource(repo,token,episode,snapshot,call,libraryOptions);
      if(next.id===snapshot?.id || !sourceSummary(snapshot,next).changed) setNotice('更新なし');
      else { setPending(next); setNotice('差分あり'); }
    } catch(e) { setNotice('確認失敗'); throw e; }
  }
  async function applySync() {
    const pendingEpisodes=pending?.episodeIds??(pending?.episodeId?[pending.episodeId]:[]);
    if(!pending || pending.repo!==repo || (pending.workId && pending.workId!==selectedWorkId) || (pending.sync?.source_branch??'main')!==sourceBranch) throw Error('対象が変わりました。GitHub側の更新を確認してください');
    const p = preserveDraft(current.current);
    const affected = snapshot ? affectedScenes(snapshot, pending) : [];
    const sourceScope = pending.workId ? `${pending.repo}#${pending.workId}` : pending.repo;
    const characters = mergeSourceReferences(p.characters, pending.references, pending.repo, pending.id, sourceScope);
    const title = typeof pending.manifest?.work === 'string' ? pending.manifest.work : pending.manifest?.work?.title;
    if (typeof title !== 'string' || !title.trim()) throw Error('原稿の作品タイトルが不正です');
    const browseEpisode=pendingEpisodes.includes(episode)?episode:(pendingEpisodes[0]??episode);
    const browseScene=browseEpisode===episode?selectedSceneId:'';
    await commit({
      ...p, title, snapshots: p.snapshots.some(s => s.id === pending.id) ? p.snapshots : [...p.snapshots, pending],
      active: pending.id,
      characters,
      ...(pending.workId ? {workId:pending.workId,sourceSelection:{workId:pending.workId,episodeId:browseEpisode,sceneId:browseScene,episodeIds:pendingEpisodes,branch:sourceBranch}} : {}),
    });
    setSelectedEpisodeIds(pendingEpisodes);
    setNotice(`原作と基準画${pending.references.length}件を取り込みました。${affected.length ? `${affected.length}場面に変更があります。既存の原稿を残す場合は「別の初稿を作る」を選んでください。` : '「漫画にする」で制作できます。'}`); setPending(null);
  }
  async function produce() {
    return produceDraft({ finalizeSource:async()=>{const saved=await finalizeProducedSource(current.current,call);const p=typeof saved==='string'?JSON.parse(saved):saved;current.current=p;setProject(p);}, current: () => current.current, commit, cancelled: () => cancel.current, model, productionMode, imageModelId,
      setBusy, setNotice, stagePanel, planScene, generatePanel, askLLM, imageOf, pagePNG,
      showProof: image => { setPage(0); setStage('finish'); setPagePreview(image); } });
  }
  async function stagePanel(panelId, instruction = '') {
    if (!model.connectionId) throw Error('先に演出AIの接続を登録・テストしてください');
    const shot=current.current.panels.find(p=>p.id===panelId);
    if(!shot)throw Error('対象コマがありません');
    if(!shot.live_binding){const binding=await openLiveShot(call,current.current,shot);await commit({...current.current,panels:current.current.panels.map(p=>p.id===panelId?{...p,live_binding:binding}:p)});}
    return directPanel({ current: () => current.current, commit, call, panelId, instruction,
      cancelled: () => cancel.current, notify: setBusy,
      ask: async (prompt, schema) => JSON.parse(await askLLM(model, { purpose: 'direction', prompt, schema })) });
  }
  async function directChosen() {
    if (!chosen) throw Error('コマを選択してください');
    const result = await stagePanel(chosen.id, instruction.trim());
    if (result?.live) { setNotice('live編集結果を詳細調整で確認し、候補として保存してください'); return; }
    if (!cancel.current) await drawChosen(chosen.id);
    setInstruction('');
  }
  async function drawChosen(panelId = selected) {
    const p = current.current, panel = p.panels.find(x => x.id === panelId);
    if (!panel) throw Error('対象コマを選択してください');
    const capture = p.captures?.find(c => c.id === panel.capture_revision);
    if (!capture) throw Error('先にBlenderで撮影してください');
    const job = await beginJob(p, panel, 'retake', imageModelId);
    await commit({ ...p, jobs: [...p.jobs, job] });
    try {
      const generated = await generatePanel(panel, p.characters, null, '', job, capture, p.style_references ?? [], null, null, imageModelId);
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
  async function applyEdit(candidate) {
    let message='編集を保存しました。再作画は候補を確認して採用してください。';
    await executeEditSequence({current:()=>current.current,commit,candidate,cancelled:()=>cancel.current,
      check:async next=>{
        const pg=next.layout.pages.find(p=>p.id===candidate.context.pageId);
        await pagePNG(pagePanels(next,pg),next.snapshots,next.localizations,next.output_locale,pg,true,next.layout.imageCrops);
        for(const op of candidate.plan.operations) {
          if(['direction','region','finishing'].includes(op.kind)&&!desktop())throw Error('作画はMacアプリで実行してください');
          if(op.kind==='direction'&&!model.connectionId)throw Error('演出AIの接続を登録してください');
          if(['direction','region'].includes(op.kind))await beginJob(next,next.panels.find(p=>p.id===op.panelId),op.kind==='region'?'edit':'retake',imageModelId);
          await checkPanelAction(next,op,imageModelId);
        }
      },
      perform:async(op,context)=>{
        setSelected(op.panelId);
        if(['resolution','upscale','finishing','video_prepare','video_assign'].includes(op.kind)){message=await panelAction(()=>current.current,commit,op,id=>{setRequestedShot(id);setMedium('video');},imageModelId);return;}
        if(op.kind==='direction') {const result=await stagePanel(op.panelId,op.args.instruction);if(!result?.live&&!cancel.current)await drawChosen(op.panelId);return;}
        if(op.kind==='region') {
          const p=current.current,panel=p.panels.find(p=>p.id===op.panelId),job=await beginJob(p,panel,'edit',imageModelId);
          await commit({...p,jobs:[...p.jobs,job]});
          try {const next=await editRegion(panel,p.characters,op.args.instruction,regionForEdit(context,op.panelId),job,p.style_references??[],imageModelId);await commit(await finishJob(current.current,job,next,cancel.current,true));}
          catch(e){await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'unknown'}:j)});throw e;}
        }
      }});
    if(cancel.current)return;
    if(candidate.jobId)await commit(resolveEditProposal(current.current,candidate.jobId,'complete'));
    setEditCandidate(null);setInstruction('');setNotice(message);
  }
  async function edit() {
    if(!instruction.trim())throw Error('修正内容を入力してください');
    const p=current.current,context=editContext(p,page,selected,rect);
    const layerJob=p.jobs.find(j=>j.compositor&&j.panelId===chosen?.id&&['running','unknown'].includes(j.status));
    if(layerJob){
      if(layerJob.kind==='layer_edit'&&!layerJob.layer_edit_applied)throw Error('生成済みレイヤーを回収してから移動してください');
      const sessionId=layerJob.compositor.session_id??layerJob.id;
      const state=await call('compositor_call',{sessionId,request:{op:'state'}});
      const {planLayerMove}=await import('./layer-edit.js'),{operation}=await import('./compositor.js');
      const args=planLayerMove(p,layerJob,state,instruction);
      const result=await call('compositor_call',{sessionId,request:operation(state,'transform',args)});
      window.dispatchEvent(new CustomEvent('compositor-state',{detail:{sessionId,state:result.state??result}}));
      setInstruction('');setNotice('人物レイヤーを移動しました。候補に保存してから採用できます');return;
    }
    // Explicit manual region selection also works without an LLM connection.
    if(chosen && rect && editRoute(instruction).kind==='region') {
      await applyEdit({base:editBase(p),context,plan:{reason:instruction,operations:[{kind:'region',panelId:chosen.id,args:{instruction}}]}});return;
    }
    const candidate=await planEdit(p,context,instruction,(prompt,schema)=>askLLM(model,{purpose:'edit',prompt,schema}),jev?.connectionId?(instruction,context)=>classifyEdit(jev,instruction,context):null,model.visualEditing?(ids,text)=>recognizeRegions(p,ids,text,(prompt,schema,images)=>askLLM(model,{purpose:'vision',prompt,schema,images}),imageOf):null);
    if(cancel.current)return;
    const saved=await commit(await saveEditProposal(current.current,candidate));
    const stored=await loadEditProposal(saved,saved.jobs.at(-1).id);
    setEditCandidate(stored);
    if(autoApply && !candidate.context.visual && candidate.plan.operations.every(op=>['lettering','crop','layout'].includes(op.kind)))await applyEdit(stored);
  }
  async function sample() {
    if (project.snapshots.length) throw Error('作品を保護するためサンプルは空の状態でのみ開けます');
    const s = { id: 'sample', sha: 'sample', manifest: { work: '制作画面のサンプル' }, settings: [], scenes: [{ id: 'S01', text: '放課後の図書館。窓から光が差し込む。\n\n「ここ、空いてる？」\n\n彼女は顔を上げ、隣の椅子を引いた。\n\n「どうぞ」', design: '' }] };
    const ps = sourceUnits('S01', s.scenes[0].text).map((u, i) => ({ id: `S01:p${i}`, sceneId: 'S01', snapshotId: 'sample', unitIds: [u.id], prompt: 'Library scene', characterIds: [], image: null, status: 'planned', instructions: [], attempts: 0 }));
    await commit({ ...emptyProject(), title: s.manifest.work, snapshots: [s], active: s.id, panels: ps });
    setStage('art');
  }
  const pageThumbnails = useMemo(() => layout.pages.map((item,i) => <button className={`thumbnail ${page===i?'active':''}`} aria-current={page===i?'page':undefined} aria-label={`${i+1}ページ目 · ${draftPageStatus(project,item)}`} key={item.id??i} onClick={()=>{setPage(i);setPagePreview(null);setSelected(null);setRect(null);}}><div className="mini-grid">{pagePanels(project,item).map(p=><div key={p.id}>{p.image?<img loading="lazy" decoding="async" src={p.image} alt=""/>:<span>未作画</span>}</div>)}</div><span>PAGE {String(i+1).padStart(2,'0')} · {draftPageStatus(project,item)}</span></button>),[project,layout,page]);
  const selectedImageModel = imageModel(imageModelId);
  function point(e) { const box = e.currentTarget.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (e.clientY - box.top) / box.height))]; }
  if (!ready) return <div className="startup-state"><h1>Manga Mac</h1>{loadError ? <><p role="alert">{loadError}</p><button className="primary" onClick={() => setLoadAttempt(value => value + 1)}>もう一度読み込む</button></> : <p role="status">作品を読み込み中…</p>}</div>;
  return <div className="app"><header><div className="brand">M<span>↗</span></div><div><strong>Manga Mac</strong><small>原作から、漫画へ。</small></div><div className="spacer"/><span className="local">● {model.connectionId ? (model.provider === 'ollama' ? 'Ollama接続' : '外部LLM接続') : '演出AI未接続'}</span><button disabled={!!busy || !ready} onClick={() => setSettings(!settings)}>接続・人物設定</button>{project.panels.length > 0 && <details className="export-menu"><summary>書き出す</summary><div className="export-options"><button disabled={!!busy || !panels.length} onClick={() => run('PNGを書き出し', async () => { const data = await pagePNG(panels, project.snapshots, project.localizations, project.output_locale, pageData, false, project.layout.imageCrops); await download(new Blob([Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0))], { type: 'image/png' }), `page-${page + 1}-${project.output_locale}.png`); })}>PNG</button><button disabled={!!busy || !project.panels.length || !desktop()} onClick={() => run('Live Mangaを書き出し中', async () => { const result = await exportLiveManga(structuredClone(current.current)); setNotice(`Live Manga ${result.releaseId} · ${result.path} · 検証済み`); })}>Live Mangaを書き出す</button><button disabled={!!busy || !project.panels.length} onClick={() => run('書き出し中', async () => download(await exportCBZ(project), `manga-${project.output_locale}.cbz`))}>CBZを書き出す ↗</button></div></details>}</header>
    <div className="workspace"><aside><div className="aside-title">作品</div>{desktop()&&!library&&<button disabled={!!busy} onClick={()=>run('原稿一覧を読み込み中',async()=>restoreSourceLibrary(await call('source_library')))}>原稿一覧を再読込</button>}{library&&<SourceLibrary library={library} setLibrary={setLibrary} busy={!!busy||!ready} run={run} commit={commit} current={current} repo={repo} catalog={libraryCatalog} selectedWorkId={selectedWorkId} selectedEpisodeId={episode} selectedSceneId={selectedSceneId} selectedEpisodeIds={selectedEpisodeIds} sourceBranch={sourceBranch} onRefreshCatalog={refreshLibraryCatalog} onSelectWork={selectLibraryWork} onSelectEpisode={selectLibraryEpisode} onSelectScene={selectLibraryScene} onToggleImportEpisode={toggleImportEpisode} onSelectAllEpisodes={selectImportEpisodes} onSourceBranch={changeSourceBranch} onCheckSource={() => run('原稿の更新を確認中', checkSync)}/>}<h2>{project.title}</h2><p className="muted">{snapshot ? `原稿 ${snapshot.sha.slice(0, 8)}` : '原作未接続'} · {project.panels.length} コマ</p>{snapshot && <details className="source-contract"><summary>原稿の情報</summary><p className="muted">{protocolLabel(snapshot)}</p></details>}<label className="production-mode">制作方法<select aria-label="制作方法" disabled={!!busy} value={productionMode} onChange={e => setProductionMode(e.target.value)}><option value="blender">Blenderで演出・作画</option><option value="direct">画像AIで直接作画</option></select></label><DraftControls key={project.active} project={project} current={current} commit={commit} run={run} busy={!!busy||!desktop()} onSwitch={()=>{setPage(0);setSelected(null);setRect(null);setEditCandidate(null);setStage('art');}} onProduce={produce}/><div className="aside-title pages-label">ページ <span>{layout.pages.length}</span></div>{pageThumbnails}<div className="aside-bottom">本文と参照はそのままに。<br/>演出と作画を、この場所で。</div></aside>
    <main><div className="toolbar" aria-label="制作する媒体"><button aria-pressed={medium === 'manga'} disabled={!!busy} onClick={() => setMedium('manga')}>漫画</button><button aria-pressed={medium === 'video'} disabled={!!busy} onClick={() => setMedium('video')}>動画</button></div><div hidden={medium !== 'video'}>{busy && <div role="status" className="message progress">{busy}</div>}{error && <div role="alert" className="message error">{error}</div>}{notice && <div role="status" className="message">{notice}</div>}<Suspense fallback={<p role="status">動画制作を読み込み中…</p>}>{(videoOpened || medium === 'video') && <VideoWorkspace project={project} current={current} commit={commit} run={run} busy={!!busy} notify={setNotice} model={model} requestedShot={requestedShot} requestedPairId={requestedPairId} onPairConsumed={() => setRequestedPairId(null)} requestedPanelIds={requestedVideoPanels} onPanelsConsumed={() => setRequestedVideoPanels([])}/>}</Suspense></div><div hidden={medium !== 'manga'}><div className="toolbar"><span>{project.panels.length ? `PAGE ${String(page + 1).padStart(2, '0')}` : '制作をはじめましょう'}</span><div className="spacer"/><label className="output-language">作品言語<select aria-label="作品言語" value={project.output_locale} disabled={!!busy || !ready} onChange={e => run('作品言語を変更', () => selectOutputLocale(e.target.value))}><option value="ja">日本語（原文）</option><option value="en">English</option></select></label>{project.output_locale === 'en' && <button disabled={!!busy || !snapshot} onClick={() => run(english ? '英訳を更新中' : '英訳を作成中', translateEnglish)}>{english ? '英訳を更新' : '英訳を作る'}</button>}<button disabled={!!busy || !project.history.length} onClick={() => run('元に戻す', async () => { await commit(undoEdit(current.current)); })}>↶ 元に戻す</button><button disabled={!!busy || !project.editRedo?.length} onClick={()=>run('やり直す',()=>commit(undoEdit(current.current,true)))}>↷ やり直す</button></div>

    <nav className="workflow-nav" aria-label="漫画の制作工程">{[['source','原稿'],['layout','コマ割り編集'],['art','作画'],['finish','仕上げ']].map(([id,label],i)=><button key={id} aria-label={label} aria-pressed={stage===id} disabled={id!=='source'&&!project.panels.length} onClick={()=>{setStage(id);setRect(null);}}><span>{i+1}</span>{label}</button>)}</nav>
    <p className="stage-hint">{stage==='source'?'原稿を選び、漫画にする範囲を確認します。':stage==='layout'?'コマの大きさ・配置・本文の割当を調整します。':stage==='art'?'コマを選んで作画。下の欄から自然な言葉で修正できます。':'書き出しと同じページです。文字と画質を確認して完了にします。'}</p>
    <StagePane active={medium==='manga'&&stage==='layout'} aria-label="配置の作業"><LayoutEditor project={layoutProject} active={medium==='manga'&&stage==='layout'} current={current} commit={commit} run={run} busy={!!busy} pageIndex={page} setPage={setPage} model={model} selected={selected} onSelect={id=>{setSelected(id);setRect(null);}} cancelled={()=>cancel.current}/></StagePane>
    {stage==='finish' && pagePreview && <img className="page-proof" src={pagePreview} alt="書き出しページの確認"/>}
    {error && <div role="alert" className="message error">{error}</div>}{notice && <div role="status" className="message">{notice}</div>}{busy && <div role="status" className="message progress">◌ {busy}<button onClick={() => { cancel.current = true; cancelLLMRequests().catch(() => setError('LLMの停止状態を確認できませんでした')); setNotice('LLMへ停止を要求しました。画像処理は現在のコマが終わったところで停止します'); }}>ここまでで停止</button></div>}
    {pending && <section className="message" aria-label="原稿の取込差分"><strong>差分あり · 原稿 {pending.sha.slice(0,8)}</strong><p>取り込むまで現在の正本と漫画は変わりません。</p>{['scenes','settings','references'].map((key,i)=><div key={key}><strong>{['場面','設定','人物・参照画像'][i]}</strong><ul>{sourceSummary(snapshot,pending)[key].map(item=><li key={item}>{item}</li>)}</ul></div>)}{sourceSummary(snapshot,pending).structure&&<p>作品情報・原稿構成に変更があります。</p>}<button disabled={!!busy} onClick={() => run('原稿を取り込み中', applySync)}>取り込む</button><button disabled={!!busy} onClick={() => {setPending(null);setNotice('取込みを見送りました');}}>後で</button></section>}
    <StagePane active={medium==='manga'&&stage==='source'} aria-label="原稿の作業">{snapshot&&<><section className="source-reader" aria-label="原稿と漫画への反映状態"><h2>原稿と漫画への反映状態</h2><SourceUpdate active={medium==='manga'&&stage==='source'} project={project} busy={!!busy} current={current} commit={commit} acceptSaved={p=>{current.current=p;setProject(p);setPagePreview(null);}} run={run} model={model} imageModelId={imageModelId} cancelled={()=>cancel.current} exclusive={fn=>writer.current.exclusive(fn)}/></section><ContentReplan project={project} current={current} commit={commit} run={run} busy={!!busy} model={model}/></>}</StagePane>
    <section hidden={project.panels.length>0 ? stage!=='art' : stage!=='source'} className="art-workspace"><div>{!panels.length ? (snapshot ? <div className="welcome"><h1>{project.panels.length?'このページは空です':'原稿を取り込みました'}</h1><p>{project.panels.length?'コマ割り編集で枠とコマを割り当ててください。':'原稿の範囲を選んで漫画に反映するか、「漫画にする」で初稿を作れます。'}</p>{project.panels.length>0&&<button onClick={()=>setStage('layout')}>コマ割り編集へ</button>}</div> : <div className="welcome"><div className="welcome-icon">▤</div><h1>物語の、その先を描こう。</h1><p>完成した脚本と、キャラクターの参照画像。<br/>ふたつをつないで、最初のページをつくります。</p><button className="primary" onClick={() => setSettings(true)}>原作を接続する →</button>{!desktop() && <button disabled={!!busy || !ready} onClick={() => run('サンプルを開く', sample)}>画面のサンプルを見る</button>}<small>脚本は選択したGitHubブランチと読み取り専用で同期します。</small></div>) : <div className="page"><div className="panel-grid">{panels.map((p, i) => <article key={p.id} tabIndex={0} role="button" aria-label={`${i+1}コマ目を選択`} aria-pressed={selected===p.id} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(p.id);setRect(null);}}} className={`panel ${selected === p.id ? 'selected' : ''}`} onClick={() => { if (selected !== p.id) { setSelected(p.id); setRect(null); } }}><div className="art" onPointerDown={e => { if (busy || !p.image) return; setSelected(p.id); drag.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); setRect(null); }} onPointerUp={e => { if (!drag.current) return; const end = point(e), start = drag.current; drag.current = null; const r = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1])]; if (r[2] > .01 && r[3] > .01) setRect(r); }}>{p.image ? <img draggable="false" src={p.image} alt={`コマ ${i + 1}`}/> : <div className="placeholder"><span>0{i + 1}</span><p>作画を待っています</p></div>}{selected === p.id && rect && <div className="region" style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }}/>}</div><div className={`caption ${project.output_locale === 'en' && !project.localizations.some(item => item.locale === 'en' && item.snapshot_id === p.snapshotId) ? 'missing-translation' : ''}`}>{panelText(p)}</div><div className="panel-meta">{p.sceneId} · {p.status === 'review' ? '見た目の確認待ち' : '演出計画'}</div></article>)}</div><div className="folio">{page + 1}</div></div>}
    </div></section>
    <section className="drawing-controls" hidden={stage!=='art'||!panels.length} aria-label="参照付き作画"><h3>作画するコマ</h3>{!desktop()&&<p className="muted">画像生成はMacアプリで使えます。</p>}<p>{selectedImageModel.display_name} · {selectedImageModel.locality==='local'?'Mac内':'クラウドへの画像送信'}。原稿割当・枠・配置は保持します。</p>
      {panels.length>1&&<label><input type="checkbox" aria-label="表示ページの全コマを選択" disabled={!!busy} checked={batchPanels.length===panels.length} onChange={e=>setBatchPanels(e.target.checked?panels.map(p=>p.id):[])}/>全コマ</label>}{panels.map((p,i)=><label key={p.id}><input type="checkbox" disabled={!!busy} checked={batchPanels.includes(p.id)} onChange={e=>setBatchPanels(e.target.checked?[...batchPanels,p.id]:batchPanels.filter(id=>id!==p.id))}/>{i+1}コマ目 · {p.image?'採用済み':'未作画'}</label>)}
      {chosen&&<div className="characters">{project.characters.filter(c=>chosen.characterIds.includes(c.id)).map(c=><figure key={c.id}><img src={c.image} alt={c.name}/><figcaption>{c.name}</figcaption></figure>)}</div>}
      <button disabled={!!busy||!desktop()||!chosen} onClick={()=>run('単コマ作画',()=>producePanels({current:()=>current.current,commit,panelIds:[chosen.id],imageModelId,regenerate:!!chosen.image,cancelled:()=>cancel.current,notify:setBusy}))}>{chosen?.image?'このコマの再生成候補を作る':'このコマを生成'}</button>
      <button hidden={!batchPanels.length} disabled={!!busy||!desktop()||!batchPanels.length} onClick={()=>run('選択コマを作画',()=>producePanels({current:()=>current.current,commit,panelIds:batchPanels,imageModelId,cancelled:()=>cancel.current,notify:setBusy}))}>選択コマをまとめて生成</button>
      <button hidden={!batchPanels.length} disabled={!!busy||!batchPanels.length} onClick={()=>{setRequestedVideoPanels([...batchPanels]);setMedium('video');}}>選択コマを動画化</button>
      {chosen && <details><summary>同じ場面の未作画をまとめて生成</summary><button disabled={!!busy||!desktop()||!chosen} onClick={()=>run('セクションを作画',()=>producePanels({current:()=>current.current,commit,panelIds:current.current.panels.filter(p=>p.sceneId===chosen.sceneId&&!p.image).map(p=>p.id),imageModelId,cancelled:()=>cancel.current,notify:setBusy}))}>対象セクションの未作画を生成</button></details>}
    </section>
    {chosen && stage==='art' && <section className="shot-controls" aria-label="作画候補">
      {chosen.capture_revision && <button disabled={!!busy || !desktop()} onClick={() => run('撮影原本から漫画化中', () => drawChosen())}>撮影原本からこのコマを漫画化</button>}
      {project.jobs.filter(j => ['generate','edit','retake','compositor','decompose','layer_edit'].includes(j.kind) && !j.finishing && j.panelId === chosen.id && ['candidate', 'unknown'].includes(j.status)).map(job => <div key={job.id}>
        <p>{job.status === 'unknown' ? '応答未確定：再実行する前に結果を確認してください' : '作画候補：採用前の原稿を保持しています'}</p>
        {job.status === 'unknown' && ['generate','edit','retake'].includes(job.kind) && <button disabled={!!busy || !desktop()} onClick={() => run('保存済み作画を回収中', async () => { const receipt = job.media?.adapter_id==='runway-image'?await call('recover_cloud_image',{jobId:job.id,connectionId:current.current.mediaDefaults?.imageConnection}):await call('recover_image', { jobId: job.id }); await commit(await recoverImageResult(current.current, job.id, receipt)); setNotice('保存済み作画を候補として回収しました。再生成はしていません。'); })}>保存済み作画を回収する</button>}
        {job.output_revision && <><img className="shot-preview" src={project.artworks.find(a => a.id === job.output_revision)?.panel.image} alt="新しい作画候補"/><button disabled={!!busy} onClick={() => run('作画候補を採用中', async () => commit(await adoptCandidate(current.current, job.id)))}>この候補を採用</button></>}
        <button disabled={!!busy} onClick={() => run('要求を解決中', async () => commit(abandonJob(current.current, job.id)))}>採用せず解決する</button>
      </div>)}
    </section>}
    {chosen && <StagePane key={`art-tools:${chosen.id}`} active={medium==='manga'&&stage==='art'} aria-label="作画の追加操作">    {<React.Suspense fallback={null}><LayeredControls key={chosen.id} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy}/></React.Suspense>}
    {<React.Suspense fallback={null}><CompositorControls key={chosen.id} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy}/></React.Suspense> }
    {<PanelMotionControls project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} active={medium==='manga'&&stage==='art'} onShot={id => { setRequestedShot(id); setMedium('video'); }} onAdjacentPair={id => { setRequestedPairId(id); setMedium('video'); }}/>}
</StagePane>}
    {stage==='finish' && panels.length>0 && <label className="finish-panel-select">仕上げるコマ<select aria-label="仕上げるコマ" value={selected??''} onChange={e=>{setSelected(e.target.value||null);setRect(null);}}><option value="">コマを選ぶ</option>{panels.map((p,i)=><option value={p.id} key={p.id}>{i+1}コマ目 · {p.sceneId}</option>)}</select></label>}
    {chosen && <StagePane key={`finish-tools:${chosen.id}`} active={medium==='manga'&&stage==='finish'} aria-label="コマの仕上げ">    {panelHasText(chosen) && <LetteringControls key={`${chosen.id}:${project.revision}`} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} active={medium==='manga'&&stage==='finish'} model={model} pageIndex={page}/>}
    {<UpscaleControls key={chosen.id} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} active={medium==='manga'&&stage==='finish'} model={model} pageIndex={page}/>}
    {<FinishingControls key={`finish:${chosen.id}`} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} active={medium==='manga'&&stage==='finish'} model={model} imageModelId={imageModelId} pageIndex={page}/>}
</StagePane>}
    <StagePane active={medium==='manga'&&stage==='finish'} aria-label="仕上げの作業">
    <SectionCompletion project={project} current={current} commit={commit} run={run} busy={!!busy} onSelect={id=>{setSelected(id);const i=layout.pages.findIndex(p=>p.slots.some(s=>s.panelId===id));if(i>=0)setPage(i);}}/><LivePreviewControls key={`${project.workId}:${snapshot?.episodeId}`} writer={writer.current} current={current} ready={ready}/></StagePane>
    {chosen && stage==='art' && (productionMode==='blender'||activeDirection(project,chosen.id)) && <section className="shot-controls" aria-label="AI演出">
      <h3>このコマの演出</h3><p>下の欄に「勇の肩越しから」「もう少し寄って」などを入力してください。構図・演技の変更は撮影からやり直し、旧作画を残して候補を作ります。</p>
      <button disabled={!!busy || !desktop()} onClick={() => run('Blenderで演出中', directChosen)}>Blenderで演出して漫画化</button>
      {activeDirection(project, chosen.id) && <><p role="status">{activeDirection(project, chosen.id).message || '停止した演出があります。保存済みの結果を確認して再開します。'}</p>
        <button disabled={!!busy || !desktop()} onClick={() => run('演出を再開中', async () => { const result=await stagePanel(chosen.id); if (!result?.live&&!cancel.current) await drawChosen(chosen.id); })}>演出を再開</button>
        <button disabled={!!busy} onClick={() => run('演出を取り下げ', () => commit(abandonDirection(current.current, activeDirection(current.current, chosen.id).id)))}>演出を取り下げる</button>
      </>}
    </section>}
    <details className="shot-details" hidden={stage!=='art'}><summary>詳細調整・Blenderの保存結果を確認</summary>
    <ShotControls key={chosen?.id ?? `page-${page}`} project={project} current={current} commit={commit} panels={panels} chosen={chosen} busy={!!busy} run={run} cancelled={()=>cancel.current}/>
    </details>
    <div className="composer" hidden={!panels.length||stage==='source'}><div className="scope">{chosen?`選択中：${chosen.sceneId}`:`${page+1}ページ目のコマを読書順で指定できます`}</div><div className="input-row"><input aria-label="編集の指示" onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229&&!busy&&panels.length&&instruction.trim()){e.preventDefault();run('編集内容を確認中',edit);}}} value={instruction} onChange={e=>setInstruction(e.target.value)} placeholder="3コマ目の吹き出しを右上に"/><button className="primary" disabled={!!busy||!panels.length||!instruction.trim()} onClick={()=>run('編集内容を確認中',edit)}>修正する ↑</button></div><label><input type="checkbox" checked={autoApply} onChange={e=>setAutoApply(e.target.checked)}/>文字・枠・画像配置は自動適用する（Undo可能）</label><small>Enterで確認 · 部分修正は画像をドラッグして範囲を選択</small></div>
    {project.jobs.filter(j=>j.kind==='edit_execution'&&['partial','unknown'].includes(j.status)).map(j=><p role="status" key={j.id}>編集は途中です：{j.completed}/{j.operations.length}操作を保存。作画候補・未確定要求を確認してください。自動再送はしません。</p>)}
    <EditProposals project={project} current={current} commit={commit} run={run} busy={!!busy} onSelect={c=>{setEditCandidate(c);setPage(current.current.layout.pages.findIndex(p=>p.id===c.context.pageId));}}/>
    {editCandidate&&<section className="edit-candidate" aria-label="編集候補"><strong>{editCandidate.plan.reason}</strong>{editCandidate.context.visual&&<><p>認識した範囲を確認してください。矩形内の別の描写も変更される場合があります。</p>{editCandidate.context.visual.regions.map((r,i)=><figure key={i}><figcaption>{r.label}</figcaption><div className="recognized-region"><img src={project.panels.find(p=>p.id===r.panelId)?.image} alt="対象認識の元画像"/><span style={{left:`${r.rect[0]*100}%`,top:`${r.rect[1]*100}%`,width:`${r.rect[2]*100}%`,height:`${r.rect[3]*100}%`}}/></div></figure>)}</>}<ul>{editCandidate.plan.operations.map((op,i)=><li key={i}>{editCandidate.context.panels.find(p=>p.id===op.panelId)?.number ?? 'ページ'}{op.kind==='layout'?'':'コマ目'} · {commands[op.kind].label}</li>)}</ul><button disabled={!!busy} onClick={()=>run('編集を適用中',()=>applyEdit(editCandidate))}>この編集を適用</button><button disabled={!!busy} onClick={()=>run('候補を取り下げ',async()=>{if(editCandidate.jobId)await commit(resolveEditProposal(current.current,editCandidate.jobId,'abandoned'));setEditCandidate(null);})}>候補を取り消す</button></section>}
    </div></main>
    {settings && <Suspense fallback={<p role="status">設定を読み込み中…</p>}><SettingsPanel setSettings={setSettings} repo={repo} library={library} busy={busy} setRepo={setRepo} setPending={setPending} setNotice={setNotice} episode={episode} setEpisode={setEpisode} token={token} setToken={setToken} snapshot={snapshot} ready={ready} run={run} checkSync={checkSync} project={project} name={name} setName={setName} description={description} setDescription={setDescription} addCharacter={addCharacter} commit={commit} current={current} model={model} setModel={setModel} jev={jev} setJev={setJev} imageModelId={imageModelId} setImageModelId={setImageModelId} sourceBranch={sourceBranch}/></Suspense>}

    </div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
