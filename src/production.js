import {generatePanel} from './pipeline.js';
import {withResource} from './execution.js';
import { affectedScenes, revise } from './core.js';
import {
  draftScenes,
  prepareDraftLayout,
  finishDraftLettering,
  reviewDraft,
} from './draft.js';
import { beginJob, finishJob } from './revisions.js';
import { imageModel } from './media.js';
import { imageRequest } from './image-input.js';
import { effectiveContinuity } from './continuity.js';
import {referenceKey} from './page-name.js';
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
  if (current().namePlan?.format === 'manga-mac/name-plan/v2') {
    const {produceNameDraft} = await import('./name-v2-production.js');
    return produceNameDraft({current,commit,cancelled,model,productionMode,setBusy,setNotice,showProof,stagePanel,planScene,generatePanel,askLLM,imageOf,pagePNG,finalizeSource,imageModelId});
  }
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
        null,
        p.style_references ?? [],
        null,
        null,
        imageModelId,
        'direct',
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
export async function produceSourceCandidate({current,commit,opId,generate,recover,cancelled=()=>false,notify=()=>{},refresh=async()=>{},imageModelId=null,panelIds=null}){
 const check=()=>{const p=current(),owner=p.jobs.find(j=>j.id===opId&&j.kind==='sourcePatch');
  const c=owner?.source_candidate;if(owner?.status!=='candidate'||!c||c.prepared.identity.workId!==p.workId||c.prepared.identity.baseContentToken!==p.contentToken)throw Error('原稿反映の候補が古いか、取り下げられています');return {p,c};};
 const frozen=structuredClone(check().p);
 const candidateProject=({p,c})=>({...p,...c.patch});
 const persist=async result=>{const {p,c}=check();const patch={...c.patch,panels:result.panels};const updated={...c,patch,redrawPanelIds:c.redrawPanelIds.filter(id=>!patch.panels.find(p=>p.id===id)?.image)};
  const owned=result.jobs.filter(j=>j.sourcePatchOp===opId);
  return commit(latest=>{if(latest.workId!==p.workId)throw Error('対象作品が変わりました');return {...latest,artworks:[...latest.artworks.filter(a=>!result.artworks.some(b=>b.id===a.id)),...result.artworks],jobs:latest.jobs.map(j=>j.id===opId?{...j,source_candidate:updated}:owned.find(n=>n.id===j.id)??j)};});};
 const targets=panelIds?[...new Set(panelIds)]:[...check().c.redrawPanelIds];
 if(targets.some(id=>!check().c.redrawPanelIds.includes(id)))throw Error('未作画の候補コマだけを選んでください');
 for(const id of targets){
  if(cancelled())return;
  await refresh();
  if(JSON.stringify(check().p.characters)!==JSON.stringify(frozen.characters)||JSON.stringify(check().p.style_references)!==JSON.stringify(frozen.style_references))throw Error('参照が変わったため残りの作画を停止しました');
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
   const generated=await withResource('local-inference',1,async permit=>{await refresh();submitted=true;return generate(panel,cp.characters,null,'',job,null,cp.style_references??[],null,permit,imageModelId,'direct');},{cancelled,waiting:()=>notify('ローカル推論は1件ずつ実行します。順番を待っています')});
   await refresh();
   await persist(await finishJob(candidateProject(check()),job,generated));
  }catch(e){
   const p=current();if(p.workId===cp.workId)await commit(latest=>({...latest,jobs:latest.jobs.map(j=>j.id===job.id?{...j,status:submitted?'unknown':'cancelled',...(!submitted?{notSubmitted:true}:{})}:j)}));throw e;
  }
 }
}

// Freeze the batch before the first request. Each saved job is the recovery boundary.
export async function producePanels({current,commit,panelIds,generate=generatePanel,cancelled=()=>false,notify=()=>{},imageModelId,regenerate=false}){
 const frozen=structuredClone(current()),unique=[...new Set(panelIds)],targets=unique.map(id=>frozen.panels.find(p=>p.id===id));
 if(targets.some(p=>!p)||!targets.length)throw Error('作画するコマを選んでください');
 const requested=targets.filter(p=>regenerate||!p.image),missingReferences=[],missingScenes=[];
 const selected=requested.filter(panel=>{
  if(panel.namePlanVersion===3)return true;
  const missing=panel.characterIds.filter(id=>!frozen.characters.find(c=>c.id===id&&c.image&&c.hash));
  if(!missing.length)return true;
  missingReferences.push({panelId:panel.id,characterIds:missing.map(id=>frozen.characters.find(c=>c.id===id)?.source?.character_id??id)});
  return false;
 });
 for(const panel of selected){
  if(frozen.jobs.some(j=>j.panelId===panel.id&&['running','unknown',...(panel.namePlanVersion===3?[]:['candidate'])].includes(j.status)))throw Error('未確定の要求・保存済み候補を先に確認してください');
 }
 for(const [i,original] of selected.entries()){
  if(cancelled())break;
  const p=current(),panel=p.panels.find(x=>x.id===original.id);
  if(original.namePlanVersion===3){if(p.workId!==frozen.workId||p.activeNameEpisodeId!==frozen.activeNameEpisodeId)throw Error('制作する話が変わりました');if(!panel)continue;}
  else if(p.workId!==frozen.workId||p.active!==frozen.active||JSON.stringify(panel)!==JSON.stringify(original)||JSON.stringify(p.characters)!==JSON.stringify(frozen.characters)||JSON.stringify(p.style_references)!==JSON.stringify(frozen.style_references))throw Error('作画入力が変わったため残りのバッチを停止しました');
  const missing=panel.namePlanVersion===3?panel.characterIds.filter(id=>!p.characters.find(c=>c.id===id&&c.image&&c.hash)):[];
  if(missing.length){missingReferences.push({panelId:panel.id,characterIds:missing});continue;}
  if(panel.namePlanVersion===3&&!panel.sceneId){missingScenes.push(panel.id);continue;}
  const previousId=effectiveContinuity(panel)?.previousPanelId;
  const previous=previousId && p.panels.find(x=>x.id===previousId);
  const model=imageModel(imageModelId ?? p.mediaDefaults?.image),capacity=model.input.max_references;
  const extraReferences=(panel.referenceKeys??[]).flatMap(ref=>{
    const saved=p.nameReferences?.[referenceKey(p.workId,p.activeNameEpisodeId,ref.key,ref.role)];
    if(!saved)return [];
    if(saved.role!==ref.role||!saved.image||!saved.hash)throw Error(`参照画像 ${ref.key} の登録が不正です`);
    return [{...saved,role:ref.role,name:`${ref.role}: ${ref.key}`}];
  });
  if(panel.compositionReference){
    const selection=panel.compositionReference;
    if(selection.kind!=='capture')throw Error('選んだ構図資料が未対応です');
    const capture=p.captures?.find(item=>item.id===selection.id&&item.panel_id===panel.id);
    if(!capture?.original||!capture.image?.hash)throw Error(`構図資料 ${selection.id} の画像がありません`);
    extraReferences.push({id:capture.id,key:capture.id,name:'Saved 3D composition, camera and pose only',role:'composition',image:capture.original,hash:capture.image.hash});
  }
  const previousSizeOK=model.adapter_id!=='runway-image'||(previous?.image?.length??0)<=5_000_000;
  const continuityReference=previous?.image && previous.sceneId===panel.sceneId && p.panels.indexOf(previous)<p.panels.indexOf(panel) && previousSizeOK && panel.characterIds.length+(p.style_references?.length??0)+extraReferences.length<capacity ? previous : null;
  // Reject oversized continuity/prompts before persisting a paid or recoverable Job.
  const references=[...panel.characterIds.map(id=>({name:p.characters.find(c=>c.id===id)?.name??id,role:'character'})),...(p.style_references??[]).map(style=>({name:`Style: ${style.name}`,role:'style'})),...extraReferences,...(continuityReference?[{name:'Previous accepted panel: appearance and props only; follow current shot composition',role:'context'}]:[])];
  imageRequest({panel,references,width:model.input.min_width,height:model.input.min_height,seed:0,instruction:'',modelId:model.id});
  const job={...await beginJob(p,panel,panel.image?'retake':'generate',imageModelId,undefined,continuityReference?.id),...(panel.namePlanVersion===3?{input_references:references.map(({role,name,hash})=>({role,name,hash:hash??null})),input_direction:{prompt:panel.prompt,continuity:effectiveContinuity(panel)}}:{})};
  await commit({...p,jobs:[...p.jobs,job]});notify(`${i+1}/${selected.length} コマを作画中`);
  try{
   const result=await generate(panel,p.characters,null,'',job,null,p.style_references??[],null,null,imageModelId,'direct',{...(continuityReference?{continuityReference}:{}),extraReferences});
   await commit(await finishJob(current(),job,result,cancelled(),!!panel.image));
  }catch(e){await commit(latest=>({...latest,jobs:latest.jobs.map(j=>j.id===job.id?{...j,status:'unknown'}:j)}));throw e;}
 }
 if(missingReferences.length)notify(`参照画像がありません: ${[...new Set(missingReferences.flatMap(item=>item.characterIds))].join('、')}。該当コマは未作画です`);
 if(missingScenes.length)notify(`場面が未指定のコマ: ${missingScenes.join('、')}。該当コマは未作画です`);
 return {missingReferences,missingScenes};
}
