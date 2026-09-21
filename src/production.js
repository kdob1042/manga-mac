import {withResource} from './execution.js';
import { activeDirection } from './directing.js';
import { affectedScenes, revise } from './core.js';
import {
  draftScenes,
  prepareDraftLayout,
  finishDraftLettering,
  reviewDraft,
} from './draft.js';
import { beginJob, finishJob } from './revisions.js';
import { pagePanels } from './layout.js';
import { recognizeRegions } from './visual-regions.js';

// Application workflow: UI state and external services are supplied by the caller.
export async function produceDraft({
  current,
  commit,
  cancelled,
  model,
  productionMode,
  setBusy,
  setNotice,
  showProof,
  stagePanel,
  planScene,
  generatePanel,
  askLLM,
  imageOf,
  pagePNG,
  finalizeSource,
  imageModelId,
}) {
  if (!current().active) throw Error('まず原作を接続してください');
  let p = current();
  const snapshot = p.snapshots.find((s) => s.id === p.active),
    scenes = draftScenes(p);
  if (
    p.panels.some(
      (panel) => !snapshot.scenes.some((scene) => scene.id === panel.sceneId),
    )
  )
    throw Error(
      '対象外の場面を含む既存原稿を保持しています。自動初稿では削除しません',
    );
  // Plan all scene content before page geometry or generation; never discard accepted art.
  for (const scene of scenes) {
    if (cancelled()) return;
    let scenePanels = p.panels.filter((x) => x.sceneId === scene.id);
    const old = p.snapshots.find((s) => s.id === scenePanels[0]?.snapshotId);
    if (
      !scenePanels.length ||
      !old ||
      affectedScenes(old, snapshot).includes(scene.id)
    ) {
      if (scenePanels.some((p) => p.image))
        throw Error(
          '原作が変わった場面に採用済み作画があります。旧版を保持しているため、自動初稿では上書きしません',
        );
      setBusy(`${scene.id} の演出を設計中`);
      scenePanels = (await planScene(scene, snapshot, p.characters, model)).map(
        (panel) => ({
          ...panel,
          id: `${p.draftScope?.id ?? crypto.randomUUID()}:${panel.id}`,
        }),
      );
      if (cancelled()) return;
      p = revise(
        current(),
        [
          ...current().panels.filter((x) => x.sceneId !== scene.id),
          ...scenePanels,
        ],
        `${scene.id} の演出計画`,
      );
      p.panels = scenes.flatMap((s) =>
        p.panels.filter((x) => x.sceneId === s.id),
      );
      p = await commit(p);
    }
  }
  await prepareDraftLayout({
    current,
    commit,
    cancelled,
    ask: (prompt, schema) =>
      askLLM(model, { purpose: 'layout', prompt, schema }),
  });
  for (const id of current().panels.map((p) => p.id)) {
    if (cancelled()) break;
    const panel = current().panels.find((p) => p.id === id);
    if (panel.image) continue;
    if (
      productionMode === 'blender' &&
      (!panel.capture_revision || activeDirection(current(), id))
    )
      { const staged = await stagePanel(id); if(staged?.live) throw Error("live編集結果を詳細調整で確認し、候補保存・採用してから続行してください"); }
    if (cancelled()) break;
    setBusy(`${id} を作画中`);
    p = current();
    const livePanel = p.panels.find((x) => x.id === id),
      job = await beginJob(p, livePanel, 'generate', imageModelId);
    await commit({ ...p, jobs: [...p.jobs, job] });
    try {
      const generated = await generatePanel(
        livePanel,
        p.characters,
        null,
        '',
        job,
        p.captures?.find((c) => c.id === livePanel.capture_revision),
        p.style_references ?? [],
        null,
        null,
        imageModelId,
      );
      await commit(await finishJob(current(), job, generated, cancelled()));
    } catch (e) {
      await commit({
        ...current(),
        jobs: current().jobs.map((j) =>
          j.id === job.id ? { ...j, status: 'unknown' } : j,
        ),
      });
      throw e;
    }
  }
  await finishDraftLettering({
    current,
    commit,
    cancelled,
    notify: setBusy,
    recognize: model.visualEditing
      ? (p, panel) =>
          recognizeRegions(
            p,
            [panel.id],
            '文字配置で顔・手・重要な描写を避ける',
            (prompt, schema, images) =>
              askLLM(model, { purpose: 'vision', prompt, schema, images }),
            imageOf,
          )
      : null,
    check: async (p, id) => {
      const pg = p.layout.pages.find((pg) =>
        pg.slots.some((s) => s.panelId === id),
      );
      await pagePNG(
        pagePanels(p, pg),
        p.snapshots,
        p.localizations,
        p.output_locale,
        pg,
        true,
        p.layout.imageCrops,
      );
    },
    ask: (prompt, schema) =>
      askLLM(model, { purpose: 'lettering', prompt, schema }),
  });
  if (cancelled()) {
    setNotice('停止しました。完成したコマと文字配置は保存済みです');
    return;
  }
  if(finalizeSource)await finalizeSource();
  const proofs = await reviewDraft(current(), pagePNG);
  showProof(proofs[0]);
  setNotice(
    `初稿 ${proofs.length}ページを表示しました。人物・衣装・文字の読みやすさを確認し、下の欄か手動で修正できます。`,
  );
}

// Reuse the ordinary image jobs and recovery for a source candidate. Only the
// candidate receives generated panels; the adopted manga remains unchanged.
export async function produceSourceCandidate({current,commit,opId,generate,recover,cancelled=()=>false,notify=()=>{},refresh=async()=>{},imageModelId=null}){
 const check=()=>{const p=current(),owner=p.jobs.find(j=>j.id===opId&&j.kind==='sourcePatch');
  const c=owner?.source_candidate;if(owner?.status!=='candidate'||!c||c.prepared.identity.workId!==p.workId||c.prepared.identity.baseContentToken!==p.contentToken)throw Error('原稿反映の候補が古いか、取り下げられています');return {p,c};};
 const candidateProject=({p,c})=>({...p,...c.patch});
 const persist=async result=>{const {p,c}=check();const patch={...c.patch,panels:result.panels};const updated={...c,patch,redrawPanelIds:c.redrawPanelIds.filter(id=>!patch.panels.find(p=>p.id===id)?.image)};
  const owned=result.jobs.filter(j=>j.sourcePatchOp===opId);
  return commit(latest=>{if(latest.workId!==p.workId)throw Error('対象作品が変わりました');return {...latest,artworks:[...latest.artworks.filter(a=>!result.artworks.some(b=>b.id===a.id)),...result.artworks],jobs:latest.jobs.map(j=>j.id===opId?{...j,source_candidate:updated}:owned.find(n=>n.id===j.id)??j)};});};
 for(const id of [...check().c.redrawPanelIds]){
  if(cancelled())return;
  await refresh();
  let cp=candidateProject(check()),panel=cp.panels.find(p=>p.id===id);if(panel.image)continue;
  const pending=cp.jobs.find(j=>j.sourcePatchOp===opId&&j.panelId===id&&['unknown','candidate'].includes(j.status));
  if(pending){
   const {recoverImageResult}=await import('./image-recovery.js'),{adoptCandidate}=await import('./revisions.js');
   if(pending.status==='unknown')cp=await recoverImageResult(cp,pending.id,await recover(pending.id));
   await persist(await adoptCandidate(cp,pending.id));continue;
  }
  const job={...await beginJob(cp,panel,'generate',imageModelId),sourcePatchOp:opId};
  await commit(p=>{if(p.workId!==cp.workId)throw Error('対象作品が変わりました');return {...p,jobs:[...p.jobs,job]};});notify(`${id} の必要な作画を生成中`);
  let submitted=false;
  try {
   const generated=await withResource('local-inference',1,async permit=>{await refresh();submitted=true;return generate(panel,cp.characters,null,'',job,null,cp.style_references??[],null,permit,imageModelId);},{cancelled,waiting:()=>notify('ローカル推論は1件ずつ実行します。順番を待っています')});
   await refresh();
   await persist(await finishJob(candidateProject(check()),job,generated));
  }catch(e){
   const p=current();if(p.workId===cp.workId)await commit(latest=>({...latest,jobs:latest.jobs.map(j=>j.id===job.id?{...j,status:submitted?'unknown':'cancelled',...(!submitted?{notSubmitted:true}:{})}:j)}));throw e;
  }
 }
}
