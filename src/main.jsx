import { fetchRepositoryNamePlan, validateRepositoryNameTarget } from './name-repository.js';
import { stageEmbeddedName } from './name-entry.js';
import { nameSourceSnapshot } from './name-parts.js';
import {producePanels} from './production.js';
import {finalizeProducedSource} from './source-patch.js';
import {createProjectWriter} from './project-writer.js';
import {sourceSummary} from './source-sync.js';
import SourceLibrary from './SourceLibrary.jsx';
import SourceConnectionNotice from './SourceConnectionNotice.jsx';
import {sourceConnectionError} from './source-connection-error.js';
import { produceDraft } from './production.js';
import {recognizeRegions,regionForEdit} from './visual-regions';
import EditProposals from './EditProposals';
import DraftControls from './DraftControls';
import { panelAction, checkPanelAction } from './panel-actions';
import { classifyEdit } from './jev';
import { editContext, editBase, planEdit, undoEdit, saveEditProposal, loadEditProposal, resolveEditProposal, executeEditSequence, commands } from './edit-commands';
import { draftPageStatus, preserveDraft } from './draft';
import PanelMotionControls from './PanelMotionControls';
import { pagePanels, ensureLayout, changeLayout } from './layout.js';
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
import PageProof from './PageProof.jsx';
import ArtPage from './ArtPage.jsx';
import PageThumbnail from './PageThumbnail.jsx';
import { pagePNG } from './render.js';
import { imageOf } from './canvas-image.js';
import UpscaleControls from './UpscaleControls.jsx';
import FinishingControls from './FinishingControls.jsx';
import './style.css';
import { defaultConnection, cancelLLMRequests } from './llm';
import { useBackupSchedule } from './useBackupSchedule.js';
import { recoverImageResult } from './image-recovery';
import { beginJob, finishJob, adoptCandidate, abandonJob } from './revisions';
import { createEnglishLocalization, currentEnglishLocalization, textForPanel } from './localization';
import { protocolLabel, mergeSourceReferences } from './source-protocol';
import { fetchStoryLibrary, fetchStoryLibraryWork, fetchSourceHead, findLibraryWork, DEFAULT_STORY_LIBRARY_REPO } from './story-library.js';
import { defaultImageModelId, imageModel } from './media.js';
import { defaultVideoModelId, videoModel, videoEstimateCredits } from './media.js';
import { panelVideoDefaults, savedVideoBatches } from './video-batch.js';
import { executeVideo } from './media-runtime.js';

const ExportControls = lazy(() => import('./ExportControls.jsx'));
const CandidateComparison = lazy(() => import('./CandidateComparison.jsx'));
const PanelContextComparison = lazy(() => import('./PanelContextComparison.jsx'));
const SettingsPanel = lazy(() => import('./SettingsPanel.jsx'));
const VideoWorkspace = lazy(() => import('./VideoWorkspace.jsx'));
const SectionCompletion = lazy(() => import('./SectionCompletion.jsx'));
const LivePreviewControls = lazy(() => import('./LivePreviewControls.jsx'));
const LayoutEditor = lazy(() => import('./LayoutEditor.jsx'));
const ContentReplan = lazy(() => import('./ContentReplan.jsx'));
const SourceUpdate = lazy(() => import('./SourceUpdate.jsx'));
const SceneControls = lazy(() => import('./SceneControls.jsx'));

// Open on demand, then retain inputs and unfinished proposals between stages.
function StagePane({active, children, ...props}) {
  const visited = useRef(false);
  if (active) visited.current = true;
  return <section {...props} hidden={!active}>{visited.current ? <Suspense fallback={<p role="status" className="stage-hint">作業画面を読み込み中…</p>}>{children}</Suspense> : null}</section>;
}

function App() {
  const [exportOpen,setExportOpen]=useState(false), [exportVisited,setExportVisited]=useState(false);
  const [importOpen,setImportOpen]=useState(false),[importNameNumber,setImportNameNumber]=useState(1);
  const [sourceFailure,setSourceFailure]=useState(null), [sourceSettingsOpen,setSourceSettingsOpen]=useState(false);
  const [library,setLibrary]=useState(null), [libraryCatalog,setLibraryCatalog]=useState(null), [selectedWorkId,setSelectedWorkId]=useState(''), [selectedSceneId,setSelectedSceneId]=useState(''), [selectedEpisodeIds,setSelectedEpisodeIds]=useState([]), [sourceBranch,setSourceBranch]=useState('main');
  const [jev,setJev]=useState(null),[editCandidate,setEditCandidate]=useState(null),[autoApply,setAutoApply]=useState(false);
  const [requestedShot, setRequestedShot] = useState(null), [requestedPairId, setRequestedPairId] = useState(null), [requestedVideoPanels, setRequestedVideoPanels] = useState([]);
  const [stage,setStage] = useState('source');
  const [sourceFocus,setSourceFocus] = useState(null);
  const [loadAttempt,setLoadAttempt] = useState(0), [loadError,setLoadError] = useState('');
  const [batchPanels,setBatchPanels]=useState([]);
  const [videoConnections,setVideoConnections]=useState({}), [quickBatchApproval,setQuickBatchApproval]=useState(''), [quickBatchRunning,setQuickBatchRunning]=useState(false);
  const [requestedVideoSetup,setRequestedVideoSetup]=useState(false), quickBatchStop=useRef(false);
  const [medium, setMedium] = useState('manga');
  const [videoOpened, setVideoOpened] = useState(false);
  useEffect(() => { if (medium === 'video') setVideoOpened(true); }, [medium]);
  const [project, setProject] = useState(emptyProject), [ready, setReady] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [settings, setSettings] = useState(false);
  const [repo, setRepo] = useState(DEFAULT_STORY_LIBRARY_REPO), [token, setToken] = useState(''), [episode, setEpisode] = useState('P01'), [model, setModel] = useState(() => defaultConnection()), [imageModelId, setImageModelId] = useState(defaultImageModelId);
  const [page, setPage] = useState(0), [selected, setSelected] = useState(null), [instruction, setInstruction] = useState(''), [pending, setPending] = useState(null), [rect, setRect] = useState(null), [name, setName] = useState(''), [description, setDescription] = useState('');
  useBackupSchedule(ready, !!busy);
  const current = useRef(project), cancel = useRef(false), lock = useRef(false);
  const importClose = useRef(null);
  const sourceRetry = useRef(null), sourceTokenInput = useRef(null);
  const tokenRef = useRef(token); tokenRef.current = token;
  useEffect(()=>{if(importOpen&&sourceSettingsOpen)sourceTokenInput.current?.focus();},[importOpen,sourceSettingsOpen]);
  useEffect(()=>{
    if(!importOpen)return;
    const previous=document.activeElement;
    importClose.current?.focus();
    const onKey=e=>{
      if(e.key==='Escape'){e.stopPropagation();setImportOpen(false);return;}
      if(e.key!=='Tab')return;
      const dialog=importClose.current?.closest('[role="dialog"]');
      const focusable=[...(dialog?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')??[])].filter(node=>node.getClientRects().length);
      if(!focusable.length)return;
      const first=focusable[0],last=focusable.at(-1);
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',onKey);
    return()=>{document.removeEventListener('keydown',onKey);previous?.focus?.();};
  },[importOpen]);
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
    let lib=null;
    if (desktop()) {
      try { lib = await call('source_library'); }
      catch (e) { if (!stopped) { setNotice('原稿一覧を読み込めませんでした。保存済み作品は編集できます。'); setSourceFailure(sourceConnectionError(e,{operation:'登録済み作品の一覧',build:import.meta.env.VITE_BUILD_SHA})); sourceRetry.current=()=>run('原稿一覧を読み込み中',async()=>restoreSourceLibrary(await call('source_library')),'登録済み作品の一覧'); } }
      if (stopped) return;
      if (lib) restoreSourceLibrary(lib, loaded);
    }
    setSourceBranch(loaded.sourceSelection?.branch ?? s?.sync?.source_branch ?? 'main');
    setSelectedEpisodeIds(loaded.sourceSelection?.episodeIds ?? s?.episodeIds ?? (s?.episodeId ? [s.episodeId] : []));
    showScene(loaded,loaded.sourceSelection?.sceneId);
    try {
      const viewKey=lib?.active??loaded.workId;
      const saved=viewKey ? JSON.parse(localStorage.getItem(`manga-ui:${viewKey}`)??'null') : null;
      if(saved&&['source','layout','art','finish'].includes(saved.stage)){
        setStage(loaded.panels.length?saved.stage:'source');
        setPage(Math.min(Math.max(0,saved.page||0),Math.max(0,(loaded.layout?.pages?.length??0)-1)));
      }
    }catch{/* The workspace remains usable if an old view preference is invalid. */}
    setReady(true);
  }).catch(e => { if (!stopped) setLoadError(`保存作品を読み込めません: ${e.message}`); }); return () => { stopped = true; }; }, [loadAttempt]);
  const writer=useRef(null);if(!writer.current)writer.current=createProjectWriter({current:()=>current.current,save:saveProject,accept:p=>{current.current=p;setProject(p);}});
  function commit(p) { return writer.current.commit(p); }
  async function run(label, fn, sourceOperation='') { if (lock.current) return; lock.current = true; setBusy(label); setError(''); setSourceFailure(null); setNotice(''); cancel.current = false; try { await fn(); } catch (e) { if (e?.message==='確認後に原稿ブランチが更新されました。もう一度「更新を確認」してください') setError(e.message); else if (sourceOperation) { setSourceFailure(sourceConnectionError(e,{operation:sourceOperation,branch:sourceBranch,build:import.meta.env.VITE_BUILD_SHA})); sourceRetry.current=()=>run(label,fn,sourceOperation); } else setError(e.message ?? String(e)); } finally { setBusy(''); lock.current = false; } }
  const snapshot = nameSourceSnapshot(project);
  useEffect(()=>setSourceFocus(null),[project.workId,project.active]);
  const sourceSceneTitles = new Map((Array.isArray(snapshot?.manifest?.episodes)?snapshot.manifest.episodes:[]).flatMap(item=>(Array.isArray(item.scenes)?item.scenes:[]).map(scene=>[scene.id,scene.title])));
  const unavailableReferenceMessage = source => source?.unavailableReferences?.length
    ? `原稿の参照画像${source.unavailableReferences.length}件は画像形式が不正なため取り込めませんでした（${source.unavailableReferences.map(item=>item.name).join('、')}）。原稿本文と他の参照画像は取り込めます。`
    : '';
  useEffect(()=>{
    const viewKey=library?.active??project.workId;
    if(!ready||!viewKey)return;
    try { localStorage.setItem(`manga-ui:${viewKey}`,JSON.stringify({stage,page})); }catch{/* View preferences are optional. */}
  },[ready,library?.active,project.workId,stage,page]);
  const layout = useMemo(() => project.layout ?? ensureLayout(project).layout, [project]);
  const layoutProject = useMemo(() => project.layout === layout ? project : {...project,layout}, [project,layout]);
  const pageData = layout.pages[page];
  const panels = useMemo(() => pagePanels(project,pageData), [project,pageData]);
  const chosen = panels.find(p => p.id === selected);
  const quickVideoModelId = project.mediaDefaults?.video ?? defaultVideoModelId;
  const quickVideoModel = videoModel(quickVideoModelId);
  const quickVideoConnection = videoConnections[quickVideoModelId] ?? '';
  const quickVideoRows = batchPanels.map(id => ({ id, recipe: panelVideoDefaults(project,id,quickVideoModelId) }));
  const quickVideoInvalid = quickVideoRows.find(item => !item.recipe.valid);
  const quickVideoCost = quickVideoRows.reduce((sum,item) => sum + (item.recipe.estimate?.credits ?? 0),0);
  const quickVideoFingerprint = JSON.stringify({ ids: batchPanels, model: quickVideoModelId, connection: quickVideoConnection, source: project.active,
    rows: quickVideoRows.map(item => [item.id,item.recipe.artwork?.id,item.recipe.artwork?.hash,item.recipe.ratio,item.recipe.duration,item.recipe.valid]) });
  const pendingQuickBatches = savedVideoBatches(project).filter(batch => batch.shots.some(({shot}) => batchPanels.includes(shot.sourcePanelId)) && batch.shots.some(({job}) => !job));
  async function quickVideo(panelIds, batchId = null, promptOverrides = {}) {
    if (!desktop()) throw Error('動画生成はMacアプリで実行してください');
    const p = current.current, modelId = p.mediaDefaults?.video ?? defaultVideoModelId, connectionId = videoConnections[modelId];
    if (!connectionId) {
      setRequestedVideoSetup(true); setMedium('video');
      setNotice('動画の接続と費用上限を一度設定してください。設定後はコマから直接実行できます。');
      return;
    }
    await run('コマの動画を生成中',async()=>{
      const { runPanelVideos } = await import('./video-quick.js');
      quickBatchStop.current=false; setQuickBatchRunning(panelIds.length>1 || !!batchId);
      try {
        const result=await runPanelVideos({ panelIds,batchId,modelId,connectionId,motionConnection:model,promptOverrides,
          getProject:()=>current.current,commit,loadCapture:(sessionId,requestId)=>call('legacy_capture_read',{sessionId,requestId}),
          submit:job=>executeVideo('submit',modelId,connectionId,{jobId:job.id}),
          refresh:async()=>{const latest=await loadProject();if(!latest)throw Error('作品を再読込できません');await commit(latest);},
          shouldStop:()=>quickBatchStop.current,onProgress:(count,total)=>setNotice(`${count}/${total}コマを送信しました。`),
        });
        setNotice(result.stopped?`${result.submitted}コマで停止しました。残りは同じ画面から再開できます。`:`${result.submitted}コマの動画候補を生成しました。採用はコマから確認してください。`);
      } finally { setQuickBatchRunning(false);setQuickBatchApproval(''); }
    });
  }
  useEffect(()=>setRect(null),[page,selected]);
  const drawingIds=batchPanels.length ? batchPanels.filter(id=>!panels.find(p=>p.id===id)?.image) : chosen?[chosen.id]:[];
  useEffect(() => { if (page >= layout.pages.length) setPage(Math.max(0,layout.pages.length-1)); }, [page,layout.pages.length]);
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
  async function refreshLibraryCatalog(branch=sourceBranch) {
    const loaded = await fetchStoryLibrary(DEFAULT_STORY_LIBRARY_REPO, tokenRef.current, call, branch);
    const entry = library?.entries.find(item => item.id === library.active);
    const workId = entry?.work_id ?? current.current.sourceSelection?.workId ?? current.current.workId ?? '';
    const savedWork = findLibraryWork(loaded.catalog, workId);
    if (savedWork && savedWork.formats.includes('manga') && ['imported', 'verified'].includes(savedWork.importStatus)) {
      const detail = await fetchStoryLibraryWork(loaded, workId, tokenRef.current, call);
      setLibraryCatalog({...loaded,...detail});
      setSelectedWorkId(workId);
      const available=detail.outline.map(item=>item.id);
      const browse=available.includes(episode) ? episode : available.includes(entry?.episode) ? entry.episode : (detail.outline[0]?.id ?? 'P01');
      const browseItem=detail.outline.find(item=>item.id===browse);
      setEpisode(browse);
      setSelectedSceneId(browseItem?.scenes.some(scene=>scene.id===selectedSceneId) ? selectedSceneId : browseItem?.scenes.some(scene=>scene.id===entry?.scene) ? entry.scene : (browseItem?.scenes[0]?.id ?? ''));
      const kept=selectedEpisodeIds.filter(id=>available.includes(id));
      setSelectedEpisodeIds(kept.length ? kept : [browse]);
    } else {
      setLibraryCatalog(loaded);
      setSelectedWorkId('');
    }
    setNotice(`原稿一覧を読み込みました（${loaded.catalog.works.length}作品、${loaded.branch} @${loaded.sha.slice(0,8)}）。`);
  }
  function openImport() {
    setSettings(false);
    setImportOpen(true);
    if (!libraryCatalog) void run('原稿一覧を読み込み中', () => refreshLibraryCatalog(),'原稿カタログの取得');
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
    // Keep the native workspace as active until backup_open actually changes it.
    setLibrary(previous=>previous ? {...previous,entries:result.entries} : previous);
    return result;
  }
  async function selectLibraryWork(workId) {
    if (!libraryCatalog) throw Error('先に原稿一覧を更新してください');
    const detail=await fetchStoryLibraryWork(libraryCatalog,workId,tokenRef.current,call);
    const work=detail.work;
    if (!work.formats.includes('manga')) throw Error('選択作品は漫画制作対象ではありません');
    const first=detail.outline[0], firstScene=detail.outline[0]?.scenes[0];
    if (!first || !firstScene) throw Error('選択作品に話・シーンがありません');
    setPending(null);setLibraryCatalog({...detail}); setSelectedWorkId(work.id); setEpisode(first.id); setSelectedSceneId(firstScene.id); setSelectedEpisodeIds([first.id]);
  }
  async function selectLibraryEpisode(episodeId) {
    setPending(null);
    const work=findLibraryWork(libraryCatalog?.catalog,selectedWorkId), detail=libraryCatalog;
    const item=detail?.outline?.find(episodeItem=>episodeItem.id===episodeId);
    const scene=item?.scenes[0];
    if (!work||!detail?.entryPath||!item||!scene) throw Error('話の選択対象が不正です');
    setEpisode(episodeId); setSelectedSceneId(scene.id);showScene(current.current,scene.id);
    setSelectedEpisodeIds(ids=>ids.includes(episodeId)?ids:[episodeId]);
  }
  async function selectLibraryScene(sceneId) {
    setPending(null);
    const work=findLibraryWork(libraryCatalog?.catalog,selectedWorkId), detail=libraryCatalog;
    const item=detail?.outline?.find(episodeItem=>episodeItem.id===episode);
    if (!work||!detail?.entryPath||!item?.scenes.some(scene=>scene.id===sceneId)) throw Error('シーンの選択対象が不正です');
    setSelectedSceneId(sceneId);showScene(current.current,sceneId);
  }
  function toggleImportEpisode(id,checked) {
    return run('取込範囲を保存',async()=>{
      const available=libraryCatalog?.outline?.map(item=>item.id)??[];
      if(!available.includes(id))throw Error('取込対象の話が変わりました');
      const next=checked?[...new Set([...selectedEpisodeIds,id])]:selectedEpisodeIds.filter(item=>item!==id);
      setSelectedEpisodeIds(next);setPending(null);
    });
  }
  function selectImportEpisodes(all) {
    return run('取込範囲を保存',async()=>{
      const next=all?(libraryCatalog?.outline?.map(item=>item.id)??[]):[episode];
      setSelectedEpisodeIds(next);setPending(null);
    });
  }
  async function changeSourceBranch(branch) {
    if(!['dev','main'].includes(branch))throw Error('原稿ブランチはdevまたはmainを選んでください');
    await refreshLibraryCatalog(branch);
    setSourceBranch(branch);setPending(null);
  }
  async function importRepositoryName() {
    const detail=libraryCatalog,work=detail?.work;
    if(!work||!episode)throw Error('作品と話を選んでください');
    const base=current.current;
    const fetched=await fetchRepositoryNamePlan({repo:detail.repo,sha:detail.sha,workId:work.id,episodeIds:[episode],library:{root:work.root}},episode,tokenRef.current,call,importNameNumber);
    const data=JSON.parse(fetched.raw);validateRepositoryNameTarget(base,data,fetched);
    const next=await stageEmbeddedName(base,fetched.raw,fetched);
    if(current.current!==base)throw Error('取込中に作品が変わりました');
    await commit(next);setImportOpen(false);setStage('art');setMedium('manga');
  }
  async function confirmImport() {
    const detail=libraryCatalog, work=detail?.work;
    if (!work || work.id!==selectedWorkId || !selectedEpisodeIds.length) throw Error('作品と取り込む話を選んでください');
    const entry=library?.entries.find(item=>item.id===library.active);
    const existing=library?.entries.find(item=>item.work_id===work.id&&item.repo===detail.repo);
    const hasContent=['snapshots','panels','artworks','characters','style_references','history','jobs','localizations','captures','videoShots','videoRevisions','videoHistory'].some(key=>Array.isArray(current.current[key])&&current.current[key].length>0)||current.current.layout?.pages?.length>0;
    const reuseEmpty=!!entry&&!entry.work_id&&entry.repo?.toLowerCase()===detail.repo.toLowerCase()&&!hasContent;
    const id=existing?.id??(reuseEmpty?entry.id:null);
    if(!entry||id!==library?.active)await commit(current.current);
    const result=await persistLibrarySelection(work,detail,episode,selectedSceneId,id);
    if(result.id!==library?.active){
      sessionStorage.setItem('manga-import-resume',JSON.stringify({branch:sourceBranch,episode,scene:selectedSceneId,episodeIds:selectedEpisodeIds}));
      await call('backup_open',{workspace:result.id});
      return;
    }
    setRepo(detail.repo);
    await checkSync({entry:{...entry,id:result.id,work_id:work.id,repo:detail.repo,scene:selectedSceneId},detail});
    setImportOpen(false);
    setStage('source');
  }
  useEffect(()=>{
    const resume=ready&&sessionStorage.getItem('manga-import-resume');
    if(resume){
      sessionStorage.removeItem('manga-import-resume');
      const selection=JSON.parse(resume);
      setSourceBranch(selection.branch);
      setImportOpen(true);
      void run('原稿一覧を読み込み中',async()=>{
        await refreshLibraryCatalog(selection.branch);
        setEpisode(selection.episode);
        setSelectedSceneId(selection.scene);
        setSelectedEpisodeIds(selection.episodeIds);
      },'原稿カタログの取得');
    }
  },[ready]);
  async function checkSync(options={}) {
    try {
      const entry=options.entry??library?.entries.find(item=>item.id===library.active);
      const targetRepo=options.detail?.repo??repo;
      let libraryOptions={branch:sourceBranch,episodeIds:[episode]};
      if(entry?.work_id){
        const loaded=await fetchStoryLibrary(entry.repo||DEFAULT_STORY_LIBRARY_REPO,tokenRef.current,call,sourceBranch);
        const detail=await fetchStoryLibraryWork(loaded,entry.work_id,tokenRef.current,call);
        setLibraryCatalog({...loaded,...detail});
        const available=new Set(detail.outline.map(item=>item.id));
        const requested=(selectedEpisodeIds.length?selectedEpisodeIds:[episode]).filter(id=>available.has(id));
        if(!requested.length||requested.length!==(selectedEpisodeIds.length?selectedEpisodeIds:[episode]).length)throw Error('取り込む話を選び直してください');
        if(!options.detail){
          const saved=await call('source_register',{
            name:detail.work.title,repo:detail.repo,episode,id:entry.id,workId:entry.work_id,workRoot:detail.work.root,
            manifestPath:detail.entryPath,catalogCommit:detail.sha,scene:selectedSceneId||entry.scene,format:detail.work.manuscriptFormat,
          });
          setLibrary({...library,entries:saved.entries});
        }
        libraryOptions={
          commit:detail.sha,branch:sourceBranch,transport:detail.transport,workId:entry.work_id,workRoot:detail.work.root,sourceRoot:detail.sourceRoot,
          manifestPath:detail.entryPath,episodeIds:requested,format:detail.work.manuscriptFormat,
        };
      } else if(library && entry) {
        const saved=await call('source_register',{name:entry.name,repo:entry.repo,episode,id:entry.id});
        setLibrary({...library,entries:saved.entries});
      }
      const next=await syncSource(targetRepo,tokenRef.current,episode,snapshot,call,libraryOptions);
      if(entry?.work_id&&entry.work_id===current.current.workId){
        await commit({...current.current,sourceSelection:{...current.current.sourceSelection,workId:entry.work_id,episodeId:episode,sceneId:selectedSceneId,episodeIds:selectedEpisodeIds,branch:sourceBranch}});
      }
      if(!sourceSummary(snapshot,next).changed) {setPending(null);setNotice('更新なし');}
      else { setPending(next); setNotice('差分あり'); }
    } catch(e) { setNotice('確認失敗'); throw e; }
  }
  async function applySync() {
    const pendingEpisodes=pending?.episodeIds??(pending?.episodeId?[pending.episodeId]:[]);
    if(!pending || pending.repo!==repo || (pending.workId && pending.workId!==selectedWorkId) || (pending.sync?.source_branch??'main')!==sourceBranch) throw Error('対象が変わりました。GitHub側の更新を確認してください');
    const head=await fetchSourceHead(pending.repo,tokenRef.current,call,sourceBranch);
    if(head.sha!==pending.sha){setPending(null);throw Error('確認後に原稿ブランチが更新されました。もう一度「更新を確認」してください');}
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
    setNotice(`原作と基準画${pending.references.length}件を取り込みました。${pending.unavailableReferences?.length ? `形式が不正な基準画${pending.unavailableReferences.length}件は除外しました。` : ''}${affected.length ? `${affected.length}場面に変更があります。既存の原稿を残す場合は「別の初稿を作る」を選んでください。` : '「漫画にする」で制作できます。'}`); setPending(null);
  }
  async function produce() {
    return produceDraft({ finalizeSource:async()=>{const saved=await finalizeProducedSource(current.current,call);const p=typeof saved==='string'?JSON.parse(saved):saved;current.current=p;setProject(p);}, current: () => current.current, commit, cancelled: () => cancel.current, model, productionMode: 'direct', imageModelId,
      setBusy, setNotice, stagePanel: async()=>{throw Error('この演出経路は終了しました。コマの3D構図を開いてください');}, planScene, generatePanel, askLLM, imageOf, pagePNG,
      showProof: (_image, pageIndex=0) => { setPage(pageIndex); setStage('finish'); } });
  }
  async function drawChosen(panelId = selected) {
    const p = current.current, panel = p.panels.find(x => x.id === panelId);
    if (!panel) throw Error('対象コマを選択してください');
    const capture = p.captures?.find(c => c.id === panel.capture_revision);
    if (!capture) throw Error('先にこのコマの3D構図を撮影してください');
    const job = await beginJob(p, panel, 'retake', imageModelId);
    await commit({ ...p, jobs: [...p.jobs, job] });
    try {
      const generated = await generatePanel(panel, p.characters, null, '', job, capture, p.style_references ?? [], null, null, imageModelId);
      await commit(await finishJob(current.current, job, generated, cancel.current, !!panel.image));
    } catch (e) {
      await commit({ ...current.current, jobs: current.current.jobs.map(j => j.id === job.id ? { ...j, status: 'unknown' } : j) }); throw e;
    }
  }
  async function openNameFile(file) {
    if(!file)return;
    await run('ネームを開く',async()=>{
      if(file.size>4*1024*1024)throw Error('ネームJSONは4MiB以内で指定してください');
      const base=current.current,next=await stageEmbeddedName(base,await file.text());
      if(current.current!==base)throw Error('取込中に作品が変わりました');
      await commit(next);setEpisode(next.jobs.at(-1).nameCandidate.file.source.episodeId);setStage('art');setMedium('manga');
    });
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
        if(op.kind==='direction') throw Error('この演出経路は終了しました。対象コマの3D構図を開いてください');
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
  const pageThumbnails = useMemo(() => layout.pages.map((item,i) => <button className={`thumbnail ${page===i?'active':''}`} aria-current={page===i?'page':undefined} aria-label={`${i+1}ページ目 · ${draftPageStatus(project,item)}`} key={item.id??i} onClick={()=>{setPage(i);setSelected(null);setRect(null);}}><PageThumbnail page={item} panels={pagePanels(project,item)}/><span>PAGE {String(i+1).padStart(2,'0')} · {draftPageStatus(project,item)}</span></button>),[project,layout,page]);
  const selectedImageModel = imageModel(imageModelId);
  const chosenCapture = project.captures?.find(c => c.id === chosen?.capture_revision);
  const emptyWorkspace = !snapshot && !project.panels.length && !pending && medium!=='video';
  async function switchWorkspace(id) {
    if (!id || id === library?.active) return;
    await commit(current.current);
    await call('backup_open',{workspace:id});
  }
  const draftTools = <DraftControls model={model} cancelled={()=>cancel.current} key={project.active} project={project} current={current} commit={commit} run={run} busy={!!busy} canProduce={desktop()} sourceToken={token} episodeId={episode} onSwitch={()=>{setPage(0);setSelected(null);setRect(null);setEditCandidate(null);setStage('art');}} onProduce={produce}/>;
  if (!ready) return <div className="startup-state"><h1>Manga Mac</h1>{loadError ? <><p role="alert">{loadError}</p><button className="primary" onClick={() => setLoadAttempt(value => value + 1)}>もう一度読み込む</button></> : <p role="status">作品を読み込み中…</p>}</div>;
  return <div className="app"><header><div className="brand">M<span>↗</span></div><div><strong>Manga Mac</strong><small>原作から、漫画へ。</small></div><div className="spacer"/>{(library?.entries?.length>1||(!emptyWorkspace&&library?.entries?.length>0))&&<label className="project-picker">作品<select aria-label="登録済み作品" value={library.active} disabled={!!busy} onChange={e=>run('作品を切り替え中',()=>switchWorkspace(e.target.value))}>{!library.entries.some(e=>e.id===library.active)&&<option value={library.active}>未接続の作品</option>}{library.entries.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>}{!emptyWorkspace&&!snapshot?.embeddedName&&<button disabled={!!busy||!desktop()} onClick={openImport}>原稿を開く</button>}{desktop()&&!emptyWorkspace&&!library&&<button disabled={!!busy} onClick={()=>run('原稿一覧を読み込み中',async()=>restoreSourceLibrary(await call('source_library')),'登録済み作品の一覧')}>原稿一覧を再読込</button>}<button aria-label="接続・人物設定" disabled={!!busy || !ready} onClick={() => setSettings(!settings)}>設定</button>{project.panels.length > 0 && <details className="export-menu" open={exportOpen} onToggle={e=>{setExportOpen(e.currentTarget.open);if(e.currentTarget.open)setExportVisited(true);}}><summary>書き出す</summary>{exportVisited&&<Suspense fallback={<div className="export-options">読み込み中…</div>}><ExportControls project={layoutProject} current={current} pageIndex={page} busy={!!busy} run={run} notify={setNotice} active={exportOpen} onInspect={({pageIndex,panelId,outputWidth,requiredWidth,requiredHeight,unknown,stage:targetStage='finish',message})=>{setNotice(message??(unknown?'画像寸法を確認できません':`${outputWidth}px出力に必要な元画像: ${requiredWidth} × ${requiredHeight}px`));setMedium('manga');setPage(pageIndex);setSelected(panelId??null);setRect(null);setStage(targetStage);setExportOpen(false);}}/></Suspense>}</details>}</header>
    <div className="workspace"><aside hidden={emptyWorkspace}><div className="aside-title">{stage==='source'?'原稿':'ページ'}</div><h2>{project.title}</h2><p className="muted">{snapshot?.embeddedName ? 'ネーム内の原文を使用' : snapshot ? `採用 ${snapshot.sync?.source_branch??'main'} @ ${snapshot.sha.slice(0, 8)} · ${snapshot.sync?.transport==='local'?'ローカル Git':snapshot.sync?.transport==='github'?'GitHub API':'取得方法未記録'}` : '原稿未接続'} · {project.panels.length} コマ</p>{snapshot&&!snapshot.embeddedName&&stage==='source'&&<><p className="muted">{snapshot.scenes.length}場面 · {snapshot.sync?.source_branch??sourceBranch}</p><button disabled={!!busy} onClick={()=>run('原稿の更新を確認中',checkSync,'原稿の更新確認')}>更新を確認</button><nav className="source-scene-nav" aria-label="原稿の場面">{snapshot.scenes.map((scene,i)=>{const title=sourceSceneTitles.get(scene.id)??scene.title??scene.id;return <React.Fragment key={scene.id}>{(i===0||scene.episodeId!==snapshot.scenes[i-1].episodeId)&&<p>{scene.episodeTitle??scene.episodeId??'原稿'}</p>}<button aria-current={sourceFocus?.id===scene.id?'location':undefined} onClick={()=>setSourceFocus(previous=>({id:scene.id,serial:(previous?.serial??0)+1}))} aria-label={`${scene.id}へ移動`}>{title}{title!==scene.id&&<small>{scene.id}</small>}</button></React.Fragment>;})}</nav><details className="source-contract"><summary>原稿の情報</summary><p className="muted">{protocolLabel(snapshot)}</p></details></>}{stage!=='source'&&<><div className="aside-title pages-label">ページ <span>{layout.pages.length}</span></div>{pageThumbnails}</>}</aside>
    <main>{emptyWorkspace ? <section className="empty-entry"><h1>ネームを開く</h1><p>原文入りネームと人物の参照画像で漫画を制作します。原稿の別途取込みは不要です。</p><label className="file">ネームJSONを開く<input type="file" aria-label="ネームJSONを開く" accept=".json,application/json" disabled={!!busy||!ready} onChange={e=>{const file=e.target.files?.[0];e.target.value='';openNameFile(file);}}/></label>{error&&<p role="alert" className="message error">{error}</p>}{sourceFailure&&!importOpen&&<SourceConnectionNotice failure={sourceFailure} busy={!!busy} onRetry={()=>sourceRetry.current?.()} onSettings={()=>{setImportOpen(true);setSourceSettingsOpen(true);}} onSelection={()=>setImportOpen(true)}/>}{!desktop()&&<p className="muted">原稿の取込みはMacアプリで利用できます。ブラウザではサンプルを確認できます。</p>}{busy&&<p role="status">{busy}</p>}<button disabled={!!busy||!desktop()} onClick={openImport}>GitHubのネームを開く</button><button disabled={!!busy} onClick={()=>setMedium('video')}>動画</button>{!desktop()&&<button disabled={!!busy} onClick={()=>run('サンプルを開く',sample)}>サンプルを見る</button>}</section> : <><div className="toolbar" aria-label="制作する媒体"><button aria-pressed={medium === 'manga'} disabled={!!busy} onClick={() => setMedium('manga')}>漫画</button><button aria-pressed={medium === 'video'} disabled={!!busy} onClick={() => setMedium('video')}>動画</button></div><div hidden={medium !== 'video'}>{busy && <div role="status" className="message progress">{busy}</div>}{error && <div role="alert" className="message error">{error}</div>}{sourceFailure&&!importOpen&&<SourceConnectionNotice failure={sourceFailure} busy={!!busy} onRetry={()=>sourceRetry.current?.()} onSettings={()=>{setImportOpen(true);setSourceSettingsOpen(true);}} onSelection={()=>setImportOpen(true)}/>} {notice && <div role="status" className="message">{notice}</div>}<Suspense fallback={<p role="status">動画制作を読み込み中…</p>}>{(videoOpened || medium === 'video') && <VideoWorkspace project={project} current={current} commit={commit} run={run} busy={!!busy} notify={setNotice} model={model} requestedShot={requestedShot} requestedPairId={requestedPairId} onPairConsumed={() => setRequestedPairId(null)} requestedPanelIds={requestedVideoPanels} onPanelsConsumed={() => setRequestedVideoPanels([])} videoConnections={videoConnections} setVideoConnections={setVideoConnections} openSetup={requestedVideoSetup} onSetupOpened={()=>setRequestedVideoSetup(false)}/>}</Suspense></div><div hidden={medium !== 'manga'}><div className="toolbar"><span>{project.panels.length ? `PAGE ${String(page + 1).padStart(2, '0')}` : '制作をはじめましょう'}</span><div className="spacer"/>{(stage==='finish'||project.output_locale==='en')&&<label className="output-language">作品言語<select aria-label="作品言語" value={project.output_locale} disabled={!!busy || !ready} onChange={e => run('作品言語を変更', () => selectOutputLocale(e.target.value))}><option value="ja">日本語（原文）</option><option value="en">English</option></select></label>}{stage==='finish'&&project.output_locale === 'en' && <button disabled={!!busy || !snapshot} onClick={() => run(english ? '英訳を更新中' : '英訳を作成中', translateEnglish)}>{english ? '英訳を更新' : '英訳を作る'}</button>}<button disabled={!!busy || !project.history.length} onClick={() => run('元に戻す', async () => { await commit(undoEdit(current.current)); })}>↶ 元に戻す</button><button disabled={!!busy || !project.editRedo?.length} onClick={()=>run('やり直す',()=>commit(undoEdit(current.current,true)))}>↷ やり直す</button></div>

    <nav className="workflow-nav" aria-label="漫画の制作工程">{[['source',snapshot?.embeddedName?'ネーム':'原稿'],['layout','コマ割り編集'],['art','作画'],['finish','仕上げ']].map(([id,label],i)=><button key={id} aria-label={label} aria-pressed={stage===id} disabled={id!=='source'&&!project.panels.length} onClick={()=>{setStage(id);setRect(null);}}><span>{i+1}</span>{label}</button>)}</nav>
    <p className="stage-hint">{snapshot?.embeddedName&&stage==='source'?'ネームを追加・選択して制作します。人物画像は固定IDごとに登録します。':!desktop()&&stage==='source'?'原稿の取込みはMacアプリで利用できます。ブラウザではサンプルを確認できます。':stage==='source'?'原稿を選び、漫画にする範囲を確認します。':stage==='layout'?'コマの大きさ・配置・本文の割当を調整します。':stage==='art'?'コマを選んで作画。下の欄から自然な言葉で修正できます。':'書き出しと同じページです。文字と画質を確認して完了にします。'}</p>
    {medium==='manga'&&stage==='art'&&(project.namePlan?.format==='manga-mac/name-plan/v2'||snapshot?.embeddedName)&&<section className="source-reader">{draftTools}</section>}
    <section className="drawing-action" hidden={stage!=='art'||!panels.length} aria-label="作画の実行"><div><strong>作画</strong><small>{batchPanels.length?`${batchPanels.length}コマを選択中` : chosen?`${panels.findIndex(p=>p.id===chosen.id)+1}コマ目を選択中`:'ページ上でコマを選択'} · {selectedImageModel.display_name}</small></div><button className="primary" disabled={!!busy||!desktop()||!drawingIds.length} onClick={()=>run('選択コマを作画',()=>producePanels({current:()=>current.current,commit,panelIds:drawingIds,imageModelId,regenerate:!batchPanels.length&&!!chosen?.image,cancelled:()=>cancel.current,notify:setBusy}))}>{!batchPanels.length&&chosen?.image?'このコマの再生成候補を作る':drawingIds.length?`選択した${drawingIds.length}コマを作画`:'作画するコマを選ぶ'}</button></section>
    <StagePane active={medium==='manga'&&stage==='layout'} aria-label="配置の作業"><LayoutEditor project={layoutProject} active={medium==='manga'&&stage==='layout'} current={current} commit={commit} run={run} busy={!!busy} pageIndex={page} setPage={setPage} model={model} selected={selected} onSelect={id=>{setSelected(id);setRect(null);}} cancelled={()=>cancel.current}/></StagePane>
    {stage==='finish' && panels.length>0 && <label className="finish-panel-select">仕上げるコマ<select aria-label="仕上げるコマ" value={selected??''} onChange={e=>{setSelected(e.target.value||null);setRect(null);}}><option value="">コマを選ぶ</option>{panels.map((p,i)=><option value={p.id} key={p.id}>{i+1}コマ目 · {p.sceneId}</option>)}</select></label>}
    {medium==='manga' && stage==='finish' && <PageProof panels={panels} snapshots={project.snapshots} localizations={project.localizations} locale={project.output_locale} page={pageData} imageCrops={layout.imageCrops}/>}
    {error && <div role="alert" className="message error">{error}</div>}{sourceFailure&&!importOpen&&<SourceConnectionNotice failure={sourceFailure} busy={!!busy} onRetry={()=>sourceRetry.current?.()} onSettings={()=>{setImportOpen(true);setSourceSettingsOpen(true);}} onSelection={()=>setImportOpen(true)}/>} {notice && <div role="status" className="message">{notice}</div>}{busy && <div role="status" className="message progress">◌ {busy}<button onClick={() => { cancel.current = true; cancelLLMRequests().catch(() => setError('LLMの停止状態を確認できませんでした')); setNotice('LLMへ停止を要求しました。画像処理は現在のコマが終わったところで停止します'); }}>ここまでで停止</button></div>}
    {pending && <section className="message" aria-label="原稿の取込差分"><strong>確認済み {pending.sync?.source_branch??sourceBranch} @ {pending.sha.slice(0,8)} · {pending.sync?.transport==='local'?'ローカル Git':'GitHub API'}</strong><p>採用中: {snapshot ? `${snapshot.sync?.source_branch??'main'} @ ${snapshot.sha.slice(0,8)}` : 'なし'}。取り込むまで現在の正本と漫画は変わりません。</p>{sourceSummary(snapshot,pending).versionChanged&&!sourceSummary(snapshot,pending).structure&&!sourceSummary(snapshot,pending).scenes.length&&!sourceSummary(snapshot,pending).settings.length&&!sourceSummary(snapshot,pending).references.length&&<p>原稿本文の差分はありません。ネームなど他のファイルを含む取得版が更新されています。</p>}{unavailableReferenceMessage(pending)&&<p role="alert" className="message error">{unavailableReferenceMessage(pending)}</p>}{['scenes','settings','references'].map((key,i)=><div key={key}><strong>{['場面','設定','人物・参照画像'][i]}</strong><ul>{sourceSummary(snapshot,pending)[key].map(item=><li key={item}>{item}</li>)}</ul></div>)}{sourceSummary(snapshot,pending).structure&&<p>作品情報・原稿構成に変更があります。</p>}<button disabled={!!busy} onClick={() => run('原稿を取り込み中', applySync,'原稿の取込み')}>取り込む</button><button disabled={!!busy} onClick={() => {setPending(null);setNotice('取込みを見送りました');}}>後で</button></section>}
    {snapshot && unavailableReferenceMessage(snapshot) && <p role="alert" className="message error">{unavailableReferenceMessage(snapshot)}</p>}
    <StagePane active={medium==='manga'&&stage==='source'} aria-label="原稿の作業">{snapshot&&<>{draftTools}{!snapshot.embeddedName&&<><section className="source-reader" aria-label="原稿と漫画への反映状態"><h2>原稿と漫画への反映状態</h2><SourceUpdate active={medium==='manga'&&stage==='source'} project={project} busy={!!busy} current={current} commit={commit} acceptSaved={p=>{current.current=p;setProject(p);}} run={run} model={model} imageModelId={imageModelId} sourceFocus={sourceFocus} cancelled={()=>cancel.current} exclusive={fn=>writer.current.exclusive(fn)}/></section><ContentReplan project={project} current={current} commit={commit} run={run} busy={!!busy} model={model}/></>}</>}</StagePane>
    <section hidden={!!pending || (project.panels.length>0 ? stage!=='art' : stage!=='source')} className="art-workspace"><div>{!panels.length ? (snapshot ? <div className="welcome"><h1>{project.panels.length?'このページは空です':'原稿を取り込みました'}</h1><p>{project.panels.length?'コマ割り編集で枠とコマを割り当ててください。':'原稿の範囲を選んで漫画に反映するか、「漫画にする」で初稿を作れます。'}</p>{project.panels.length>0&&<button onClick={()=>setStage('layout')}>コマ割り編集へ</button>}</div> : <div className="welcome"><button className="primary" onClick={openImport}>原稿を開く</button></div>) : <ArtPage key={pageData?.id} project={layoutProject} page={pageData} panels={panels} selected={selected} onSelect={id=>{setSelected(id);setRect(null);}} onResize={(slotId,points)=>run('コマ枠を保存',async()=>{const original=current.current,next=structuredClone(original.layout),targetPage=next.pages.find(item=>item.id===pageData.id),target=targetPage?.slots.find(item=>item.id===slotId);if(!target)throw Error('編集中のコマ枠が見つかりません');target.points=points;await commit(changeLayout(original,next,'コマ枠を調整',{pageIds:[pageData.id]}));})} rect={rect} onRect={setRect} busy={!!busy} sourceText={chosen?panelText(chosen):''}/>}
    </div></section>
    <section className="drawing-controls" hidden={stage!=='art'||!panels.length} aria-label="参照付き作画"><h3>作画するコマ</h3>{!desktop()&&<p className="muted">画像生成はMacアプリで使えます。</p>}<p>{selectedImageModel.display_name} · {selectedImageModel.locality==='local'?'Mac内':'クラウドへの画像送信'}。原稿割当・枠・配置は保持します。</p>
      {panels.length>1&&<label><input type="checkbox" aria-label="表示ページの全コマを選択" disabled={!!busy} checked={batchPanels.length===panels.length} onChange={e=>setBatchPanels(e.target.checked?panels.map(p=>p.id):[])}/>全コマ</label>}{panels.map((p,i)=><label key={p.id}><input type="checkbox" disabled={!!busy} checked={batchPanels.includes(p.id)} onChange={e=>setBatchPanels(e.target.checked?[...batchPanels,p.id]:batchPanels.filter(id=>id!==p.id))}/>{i+1}コマ目 · {p.image?'採用済み':'未作画'}</label>)}
      {chosen&&<Suspense fallback={null}><PanelContextComparison key={chosen.id} project={layoutProject} panelId={chosen.id}/></Suspense>}
      {batchPanels.length>0 && <section aria-label="選択コマの動画生成" className="video-quick-batch">
        <p>{batchPanels.length}コマ · {quickVideoModel.display_name} · {quickVideoModel.locality==='local'?'このMacで生成':quickVideoInvalid?'費用を計算できません':`最大${quickVideoCost} credits`}</p>
        {quickVideoInvalid && <p role="alert">{quickVideoInvalid.id}: {quickVideoInvalid.recipe.reason}</p>}
        {!quickVideoConnection && <button disabled={!!busy} onClick={()=>quickVideo(batchPanels)}>動画の接続を設定</button>}
        {quickVideoConnection && !quickVideoInvalid && <><label><input type="checkbox" checked={quickBatchApproval===quickVideoFingerprint} disabled={!!busy} onChange={e=>setQuickBatchApproval(e.target.checked?quickVideoFingerprint:'')}/>件数・モデル・費用を確認して生成する</label>
        <button disabled={!!busy||quickBatchApproval!==quickVideoFingerprint} onClick={()=>quickVideo([...batchPanels])}>選択コマを動画生成</button></>}
        {quickBatchRunning && <button onClick={()=>{quickBatchStop.current=true}}>次のコマから停止</button>}
        {pendingQuickBatches.map(batch=>{
          const waiting=batch.shots.filter(({job})=>!job);
          let cost=null;
          try {cost=quickVideoModel.locality==='local'?0:waiting.reduce((sum,{shot})=>sum+videoEstimateCredits(quickVideoModelId,shot.duration,shot.ratio).credits,0);}
          catch { /* The model changed; validation blocks the send. */ }
          const fingerprint=JSON.stringify({ batch:batch.id,model:quickVideoModelId,connection:quickVideoConnection,shots:waiting.map(({shot})=>shot) });
          return <details key={batch.id}><summary>未送信の{waiting.length}コマを再開</summary><p>{quickVideoModel.display_name} · {cost===null?'現在のモデルは保存済みレシピに非対応':quickVideoModel.locality==='local'?'このMacで生成':`最大${cost} credits`}</p>
            <label><input type="checkbox" checked={quickBatchApproval===fingerprint} disabled={!!busy||cost===null||!quickVideoConnection} onChange={e=>setQuickBatchApproval(e.target.checked?fingerprint:'')}/>残りの件数・モデル・費用を確認して続行</label>
            <button disabled={!!busy||cost===null||!quickVideoConnection||quickBatchApproval!==fingerprint} onClick={()=>quickVideo([],batch.id)}>未送信分を実行</button>
          </details>;
        })}
        <details><summary>動画の詳細設定</summary><button disabled={!!busy} onClick={()=>{setRequestedVideoPanels([...batchPanels]);setMedium('video');}}>選択コマを動画化</button></details>
      </section>}
      {chosen && <details><summary>同じ場面の未作画をまとめて生成</summary><button disabled={!!busy||!desktop()||!chosen} onClick={()=>run('セクションを作画',()=>producePanels({current:()=>current.current,commit,panelIds:current.current.panels.filter(p=>p.sceneId===chosen.sceneId&&!p.image).map(p=>p.id),imageModelId,cancelled:()=>cancel.current,notify:setBusy}))}>対象セクションの未作画を生成</button></details>}
    </section>
    {chosen && stage==='art' && <section className="shot-controls" aria-label="作画候補">
      {chosenCapture?.origin === 'three' && <button disabled={!!busy || !desktop()} onClick={() => run('撮影原本から漫画化中', () => drawChosen())}>撮影原本からこのコマを漫画化</button>}
      {chosenCapture && chosenCapture.origin !== 'three' && <p className="muted">旧撮影画像は保持されています。3D構図を編集する場合はGLB素材を配置して撮り直してください。</p>}
      {project.jobs.filter(j => ['generate','edit','retake','compositor','decompose','layer_edit'].includes(j.kind) && !j.finishing && j.panelId === chosen.id && ['candidate', 'unknown'].includes(j.status)).map(job => <div key={job.id}>
        <p>{job.status === 'unknown' ? '応答未確定：再実行する前に結果を確認してください' : '作画候補：採用前の原稿を保持しています'}</p>
        {job.status === 'unknown' && ['generate','edit','retake'].includes(job.kind) && <button disabled={!!busy || !desktop()} onClick={() => run('保存済み作画を回収中', async () => { const receipt = job.media?.adapter_id==='runway-image'?await call('recover_cloud_image',{jobId:job.id,connectionId:current.current.mediaDefaults?.imageConnection}):await call('recover_image', { jobId: job.id }); await commit(await recoverImageResult(current.current, job.id, receipt)); setNotice('保存済み作画を候補として回収しました。再生成はしていません。'); })}>保存済み作画を回収する</button>}
        {job.output_revision && <><Suspense fallback={<p>比較を読み込み中…</p>}><CandidateComparison project={project} job={job}/></Suspense><button disabled={!!busy} onClick={() => run('作画候補を採用中', async () => commit(await adoptCandidate(current.current, job.id)))}>この候補を採用</button></>}
        <button disabled={!!busy} onClick={() => run('要求を解決中', async () => commit(abandonJob(current.current, job.id)))}>採用せず解決する</button>
      </div>)}
    </section>}
    {chosen && <StagePane key={`art-tools:${chosen.id}`} active={medium==='manga'&&stage==='art'} aria-label="作画の追加操作">    {<React.Suspense fallback={null}><SceneControls key={chosen.id} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} model={model} active={medium==='manga'&&stage==='art'}/><LayeredControls key={chosen.id} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy}/></React.Suspense>}
    {<React.Suspense fallback={null}><CompositorControls key={chosen.id} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy}/></React.Suspense> }
    {<PanelMotionControls project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} active={medium==='manga'&&stage==='art'} onShot={id => { setRequestedShot(id); setMedium('video'); }} onAdjacentPair={id => { setRequestedPairId(id); setMedium('video'); }} onGenerate={(id,prompt)=>quickVideo([id],null,prompt?{[id]:prompt}:{})} videoModelId={quickVideoModelId} videoConnections={videoConnections}/>}
</StagePane>}
    {chosen && <StagePane key={`finish-tools:${chosen.id}`} active={medium==='manga'&&stage==='finish'} aria-label="コマの仕上げ">    {panelHasText(chosen) && <LetteringControls key={`${chosen.id}:${project.revision}`} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} active={medium==='manga'&&stage==='finish'} model={model} pageIndex={page}/>}
    {<UpscaleControls key={chosen.id} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} active={medium==='manga'&&stage==='finish'} model={model} pageIndex={page}/>}
    {<FinishingControls key={`finish:${chosen.id}`} project={project} panel={chosen} current={current} commit={commit} run={run} busy={!!busy} active={medium==='manga'&&stage==='finish'} model={model} imageModelId={imageModelId} pageIndex={page}/>}
</StagePane>}
    <StagePane active={medium==='manga'&&stage==='finish'} aria-label="仕上げの作業">
    <SectionCompletion project={project} current={current} commit={commit} run={run} busy={!!busy} onSelect={id=>{setSelected(id);const i=layout.pages.findIndex(p=>p.slots.some(s=>s.panelId===id));if(i>=0)setPage(i);}}/><LivePreviewControls key={`${project.workId}:${snapshot?.episodeId}`} writer={writer.current} current={current} ready={ready}/></StagePane>
    <div className="composer" hidden={!panels.length||stage==='source'}><div className="scope">{chosen?`選択中：${chosen.sceneId}`:`${page+1}ページ目のコマを読書順で指定できます`}</div><div className="input-row"><input aria-label="編集の指示" onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229&&!busy&&panels.length&&instruction.trim()){e.preventDefault();run('編集内容を確認中',edit);}}} value={instruction} onChange={e=>setInstruction(e.target.value)} placeholder="3コマ目の吹き出しを右上に"/><button className="primary" disabled={!!busy||!panels.length||!instruction.trim()} onClick={()=>run('編集内容を確認中',edit)}>修正する ↑</button></div><label><input type="checkbox" checked={autoApply} onChange={e=>setAutoApply(e.target.checked)}/>文字・枠・画像配置は自動適用する（Undo可能）</label><small>Enterで確認 · 部分修正は選択コマの元画像上をドラッグして範囲を選択</small></div>
    {project.jobs.filter(j=>j.kind==='edit_execution'&&['partial','unknown'].includes(j.status)).map(j=><p role="status" key={j.id}>編集は途中です：{j.completed}/{j.operations.length}操作を保存。作画候補・未確定要求を確認してください。自動再送はしません。</p>)}
    <EditProposals project={project} current={current} commit={commit} run={run} busy={!!busy} onSelect={c=>{setEditCandidate(c);setPage(current.current.layout.pages.findIndex(p=>p.id===c.context.pageId));}}/>
    {editCandidate&&<section className="edit-candidate" aria-label="編集候補"><strong>{editCandidate.plan.reason}</strong>{editCandidate.context.visual&&<><p>認識した範囲を確認してください。矩形内の別の描写も変更される場合があります。</p>{editCandidate.context.visual.regions.map((r,i)=><figure key={i}><figcaption>{r.label}</figcaption><div className="recognized-region"><img src={project.panels.find(p=>p.id===r.panelId)?.image} alt="対象認識の元画像"/><span style={{left:`${r.rect[0]*100}%`,top:`${r.rect[1]*100}%`,width:`${r.rect[2]*100}%`,height:`${r.rect[3]*100}%`}}/></div></figure>)}</>}<ul>{editCandidate.plan.operations.map((op,i)=><li key={i}>{editCandidate.context.panels.find(p=>p.id===op.panelId)?.number ?? 'ページ'}{op.kind==='layout'?'':'コマ目'} · {commands[op.kind].label}</li>)}</ul><button disabled={!!busy} onClick={()=>run('編集を適用中',()=>applyEdit(editCandidate))}>この編集を適用</button><button disabled={!!busy} onClick={()=>run('候補を取り下げ',async()=>{if(editCandidate.jobId)await commit(resolveEditProposal(current.current,editCandidate.jobId,'abandoned'));setEditCandidate(null);})}>候補を取り消す</button></section>}
    </div></>}</main>
    {settings && <Suspense fallback={<p role="status">設定を読み込み中…</p>}><SettingsPanel setSettings={setSettings} repo={repo} library={library} busy={busy} setRepo={setRepo} setPending={setPending} setNotice={setNotice} episode={episode} setEpisode={setEpisode} token={token} setToken={setToken} snapshot={snapshot} ready={ready} run={run} checkSync={checkSync} project={project} name={name} setName={setName} description={description} setDescription={setDescription} addCharacter={addCharacter} commit={commit} current={current} model={model} setModel={setModel} jev={jev} setJev={setJev} imageModelId={imageModelId} setImageModelId={setImageModelId} sourceBranch={sourceBranch}/></Suspense>}
    {importOpen&&<div className="import-overlay"><section role="dialog" aria-modal="true" aria-label="原稿を開く" className="import-dialog"><div className="setting-head"><h2>原稿を開く</h2><button ref={importClose} onClick={()=>setImportOpen(false)}>閉じる</button></div><p>作品と話を選び、差分を確認してから取り込みます。</p>{error&&<p role="alert" className="message error">{error}</p>}{sourceFailure&&<SourceConnectionNotice failure={sourceFailure} busy={!!busy} onRetry={()=>sourceRetry.current?.()} onSettings={()=>{setSourceSettingsOpen(true);}} onSelection={()=>document.querySelector('[aria-label="原稿ライブラリの作品"]')?.focus()}/>} {!desktop()&&<p className="muted">原稿の取込みはMacアプリで利用できます。ブラウザではサンプルを確認できます。</p>}{busy&&<p role="status">{busy}</p>}<SourceLibrary library={library??{entries:[],active:''}} setLibrary={setLibrary} busy={!!busy} run={run} commit={commit} current={current} catalog={libraryCatalog} selectedWorkId={selectedWorkId} selectedEpisodeId={episode} selectedSceneId={selectedSceneId} selectedEpisodeIds={selectedEpisodeIds} sourceBranch={sourceBranch} onRefreshCatalog={()=>refreshLibraryCatalog()} onSelectWork={selectLibraryWork} onSelectEpisode={selectLibraryEpisode} onSelectScene={selectLibraryScene} onToggleImportEpisode={toggleImportEpisode} onSelectAllEpisodes={selectImportEpisodes} onSourceBranch={changeSourceBranch} onConfirmImport={()=>run('原稿の変更を確認中',confirmImport,'初回取込み')}/><label>ネーム番号<input type="number" min="1" max="999999" value={importNameNumber} onChange={e=>setImportNameNumber(Number(e.target.value))}/></label><button className="primary" disabled={!!busy||!libraryCatalog?.work||!desktop()} onClick={()=>run('ネームを取得中',importRepositoryName)}>番号付きネームを開く</button><details open={sourceSettingsOpen} onToggle={e=>setSourceSettingsOpen(e.currentTarget.open)}><summary>非公開の原稿・接続設定</summary><label>読み取り専用トークン<input ref={sourceTokenInput} type="password" autoComplete="off" value={token} onChange={e=>{tokenRef.current=e.target.value;setToken(e.target.value);}}/></label><small>トークンは起動中だけ保持します。</small></details></section></div>}

    </div></div>;
}
const AcceptanceHarness = React.lazy(() => import('./AcceptanceHarness.jsx'));
function Bootstrap() {
  const [mode, setMode] = useState(() => desktop() ? { loading: true } : { context: null });
  useEffect(() => {
    if (!desktop()) return;
    call('acceptance_context').then(context => setMode({ context }))
      .catch(error => setMode({ error: error.message ?? String(error) }));
  }, []);
  // An isolation failure must never fall through to the ordinary project UI.
  if (mode.error) return <main role="alert">起動先を確認できません: {mode.error}</main>;
  if (mode.loading) return <main role="status">起動先を確認中…</main>;
  return mode.context ? <React.Suspense fallback={<main role="status">確認画面を準備中…</main>}><AcceptanceHarness context={mode.context}/></React.Suspense> : <App/>;
}
createRoot(document.getElementById('root')).render(<Bootstrap/>);
