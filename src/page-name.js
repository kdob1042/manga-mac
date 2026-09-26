import { adoptPages, editNamePage, editNameScene, nameRevision, restoreNameRevision, validateEpisode } from '../contracts/name-plan/page.mjs';
import { validateLayout } from './layout.js';
import { mergeSourceReferences } from './source-protocol.js';

const copy = value => structuredClone(value);
export const episodeKey = (workId, episodeId) => JSON.stringify([workId, episodeId]);
export const referenceKey = (workId, episodeId, assetKey, role) => JSON.stringify([workId,episodeId,role,assetKey]);
const key = episode => episodeKey(episode.workId, episode.episodeId);
const productionKeys=['status','artwork_revision','capture_revision','scene3d','shot_binding','compositionReference','generation','generationResolution','instructions','attempts','layer_state','candidateRevision'];
const production = panel => Object.fromEntries(productionKeys.filter(field=>Object.hasOwn(panel,field)).map(field=>[field,copy(panel[field])]));

// Portable names keep story IDs; only the production projection uses local IDs.
function characterBindings(project, episode) {
  const characters = [...(project.characters ?? [])], bindings = new Map();
  const repo = project.nameRepositories?.[key(episode)]?.repo
    ?? project.snapshots?.find(snapshot=>snapshot.id===project.active && snapshot.workId===episode.workId)?.repo;
  for (const person of episode.characters) {
    const exact = characters.find(character=>character.id===person.id && (!character.source
      || (repo && character.source.repo===repo && character.source.scope===`${repo}#${episode.workId}`)));
    const sources = repo ? characters.filter(character=>character.source?.repo===repo
      && character.source?.scope===`${repo}#${episode.workId}` && character.source?.character_id===person.id) : [];
    if (sources.length>1) throw Error(`人物 ${person.id} の原稿参照が重複しています`);
    const target = exact?.image && exact?.hash ? exact : sources[0] ?? exact;
    if (target) bindings.set(person.id,target.id);
    else {
      if(characters.some(character=>character.id===person.id))throw Error(`人物 ${person.id} のIDが別の原稿参照と衝突しています`);
      characters.push({...person,image:null,hash:''});
      bindings.set(person.id,person.id);
    }
  }
  return {characters,bindings};
}

// Preserve artwork and jobs under their fixed panel IDs, even while a panel is absent.
export function projectNameEpisode(project, episode) {
  validateEpisode(episode);
  if (project.workId && project.workId !== episode.workId) throw Error('別作品のネームです');
  const {characters,bindings}=characterBindings(project,episode);
  const stored = { ...(project.panelProduction ?? {}) };
  for (const panel of project.panels ?? []) stored[panel.id] = production(panel);
  const panels = episode.pageIds.flatMap(id => episode.pages.find(page => page.id === id).panels).map(panel => {
    const previous = stored[panel.id] ?? {};
    const live=project.panels?.find(item=>item.id===panel.id);
    const artwork=project.artworks?.find(item=>item.id===previous.artwork_revision);
    const { sourceRefs, contextRefs, requiredText, lettering, continuity, continuityOverride, ...other } = previous;
    const scene=episode.scenes.find(item=>item.id===panel.sceneId);
    const visual={location:scene?.location??'',timeOfDay:scene?.timeOfDay??'',props:scene?.props??[],spatial:scene?.spatial??'',hardConstraints:scene?.hardConstraints??[],
      previousPanelId:panel.previousPanelId??null,characters:panel.characters.map(character=>({id:bindings.get(character.characterId),costume:scene?.appearances?.find(a=>a.id===character.appearanceId)?.costume??'',visualState:character.visualState??'',emotion:character.emotion??'',holding:character.holding??[]}))};
    const referenceKeys=[...(scene?.backgroundReferenceKey?[{key:scene.backgroundReferenceKey,role:'background'}]:[]),...panel.characters.flatMap(character=>{
      const appearance=scene?.appearances?.find(item=>item.id===character.appearanceId);
      return appearance?.referenceKey?[{key:appearance.referenceKey,role:'costume',characterId:bindings.get(character.characterId)}]:[];
    })];
    const shown = panel.texts.filter(entry => entry.text.trim());
    const boxes = shown.map((entry, index) => ({ id: `custom:${entry.id}`, text: entry.text,
      x: entry.box?.x ?? .54, y: entry.box?.y ?? .03 + index * .85 / shown.length,
      width: entry.box?.width ?? .42, height: entry.box?.height ?? Math.min(.3, .8 / shown.length),
      kind: entry.kind === 'narration' ? 'narration' : entry.kind === 'thought' ? 'thought' : 'balloon',
      ...(entry.kind === 'narration' ? {shape:'rect'} : {}), ...(entry.style ?? {}) }));
    return { ...other, id: panel.id, namePlanVersion: 3, snapshotId: null, sceneId: panel.sceneId,
      sourceRefs: [], contextRefs: [], requiredText: [], unitIds: [], characterIds: panel.characters.map(c => bindings.get(c.characterId)),
      prompt: panel.prompt ?? '', nameIntent: panel.shotIntent ?? '', continuity:visual, continuityOverride:null, referenceKeys, image: live?.image ?? artwork?.panel?.image ?? null,
      status: previous.status ?? 'planned', instructions: previous.instructions ?? [], attempts: previous.attempts ?? 0,
      lettering: { mode: 'balloons', boxes } };
  });
  const layout = { version: 1, pages: episode.pageIds.map(id => {
    const page = episode.pages.find(page => page.id === id);
    return { id, slots: [...page.panels.filter(p => p.frame).map(panel => ({ id: panel.frame.slotId ?? `slot:${panel.id}`,
      panelId: panel.id, points: copy(panel.frame.points), ...(panel.frame.overflow ? { overflow: copy(panel.frame.overflow) } : {}) })),...(page.emptyFrames??[]).map(frame=>({...copy(frame),panelId:null}))] };
  }), knownPanelIds: panels.map(panel => panel.id), imageCrops: copy(project.layout?.imageCrops ?? {}) };
  validateLayout(layout, panels);
  const legacyNamePlans = project.legacyNamePlans ?? [project.namePlan,...(project.otherNamePlans??[])].filter(Boolean);
  return { ...project, workId: episode.workId, title: episode.title, characters, panels, layout,
    legacyNamePlans, namePlan: null, otherNamePlans: [], sourceApplication:{version:1,units:[]}, panelProduction: stored, activeNameEpisodeId: episode.episodeId };
}

export function commitNameEpisode(project, episode, reason, { saveRevision = true } = {}) {
  validateEpisode(episode);
  const id = key(episode), old = project.nameEpisodes?.[id];
  const revisions = { ...(project.nameRevisions ?? {}) };
  if (old && saveRevision) revisions[id] = [...(revisions[id] ?? []), nameRevision(old, reason)];
  const next = { ...project, nameEpisodes: { ...(project.nameEpisodes ?? {}), [id]: copy(episode) }, nameRevisions: revisions };
  return project.activeNameEpisodeId === episode.episodeId || !project.activeNameEpisodeId ? projectNameEpisode(next, episode) : next;
}

export function adoptNamePages(project, incoming, selected, options) {
  const id = key(incoming), old = project.nameEpisodes?.[id];
  const episode = old ? adoptPages(old, incoming, selected, options) : {
    ...copy(incoming), pageIds: incoming.pageIds.filter(pageId => selected.includes(pageId)),
    pages: incoming.pages.filter(page => selected.includes(page.id)) };
  return commitNameEpisode(project, validateEpisode(episode), 'ページ取込み');
}

export function adoptRepositoryNamePages(project,incoming,selected,referenceImport,options) {
  if(!referenceImport?.repo||!referenceImport.sha||!Array.isArray(referenceImport.references))throw Error('人物参照の取得版がありません');
  if(project.workId&&project.workId!==incoming.workId)throw Error('別作品のネームです');
  const scope=`${referenceImport.repo}#${incoming.workId}`;
  const characters=mergeSourceReferences(project.characters??[],referenceImport.references,referenceImport.repo,
    `${referenceImport.repo}@${referenceImport.sha}:${incoming.workId}:${incoming.episodeId}`,scope,{matchByName:false});
  return adoptNamePages({...project,characters,nameRepositories:{...(project.nameRepositories??{}),
    [key(incoming)]:{repo:referenceImport.repo,root:referenceImport.root,sha:referenceImport.sha}}},incoming,selected,options);
}

export function editProjectNamePage(project, episodeId, pageId, operations) {
  const id = episodeKey(project.workId, episodeId), old = project.nameEpisodes?.[id];
  if (!old) throw Error('話のネームがありません');
  return commitNameEpisode(project, editNamePage(old, pageId, operations), 'ページ編集', {saveRevision:false});
}

export function syncNameLayout(before, update) {
  if (!before.activeNameEpisodeId || !before.workId || JSON.stringify(before.layout) === JSON.stringify(update.layout)) return update;
  const id=episodeKey(before.workId,before.activeNameEpisodeId),original=before.nameEpisodes?.[id];
  if(!original)throw Error('編集する話のネームがありません');
  const ids=update.layout?.pages?.map(page=>page.id);
  if(JSON.stringify(ids)!==JSON.stringify(original.pageIds))throw Error('ページ管理はネームのページ操作から行ってください');
  let episode=original;
  for(const pageId of ids){
    const page=episode.pages.find(item=>item.id===pageId),layoutPage=update.layout.pages.find(item=>item.id===pageId),frames={};
    if(layoutPage.slots.some(slot=>slot.panelId!==null&&!page.panels.some(panel=>panel.id===slot.panelId)))throw Error('別ページへのコマ移動はできません');
    const placement=layoutPage.slots.filter(slot=>slot.panelId).map(slot=>slot.panelId);
    if(JSON.stringify(placement)!==JSON.stringify(page.panels.filter(panel=>placement.includes(panel.id)).map(panel=>panel.id)))throw Error('コマ順はネームのページ操作で変更してください');
    for(const panel of page.panels){
      const slot=layoutPage.slots.find(item=>item.panelId===panel.id);
      frames[panel.id]=slot?{points:copy(slot.points),slotId:slot.id,...(slot.overflow?{overflow:copy(slot.overflow)}:{})}:null;
    }
    if(page.panels.length&&JSON.stringify(frames)!==JSON.stringify(Object.fromEntries(page.panels.map(panel=>[panel.id,panel.frame]))))episode=editNamePage(episode,pageId,[{type:'setFrames',frames}]);
    const emptyFrames=layoutPage.slots.filter(slot=>slot.panelId===null).map(({panelId,...slot})=>copy(slot));
    if(JSON.stringify(emptyFrames)!==JSON.stringify(page.emptyFrames??[])){
      if(episode===original)episode=copy(original);
      episode.pages.find(item=>item.id===pageId).emptyFrames=emptyFrames;
      validateEpisode(episode);
    }
  }
  if(episode===original)return update;
  return projectNameEpisode({...update,nameEpisodes:{...before.nameEpisodes,[id]:episode}},episode);
}

export function syncNameLettering(before, update) {
  if(!before.activeNameEpisodeId || !before.workId)return update;
  const id=episodeKey(before.workId,before.activeNameEpisodeId),source=before.nameEpisodes?.[id];
  if(!source)throw Error('編集する話のネームがありません');
  let episode=source;
  for(const panel of update.panels??[]){
    const previous=before.panels.find(item=>item.id===panel.id);
    if(panel.namePlanVersion!==3||JSON.stringify(previous?.lettering)===JSON.stringify(panel.lettering))continue;
    if(episode===source)episode=copy(source);
    const owner=episode.pages.find(page=>page.panels.some(item=>item.id===panel.id));
    if(!owner)throw Error('文字を編集するコマがありません');
    const target=owner.panels.find(item=>item.id===panel.id);
    target.texts=target.texts.filter(entry=>(panel.lettering?.boxes??[]).some(box=>box.id===`custom:${entry.id}`));
    for(const box of panel.lettering?.boxes??[]){
      if(!box.id?.startsWith('custom:'))throw Error('ネームの文字枠IDが不正です');
      const entryId=box.id.slice(7),entry=target.texts.find(item=>item.id===entryId);
      const {x,y,width,height,...style}=box;
      const next={text:box.text,kind:box.kind==='balloon'?'dialogue':box.kind??'dialogue',box:{x,y,width,height},style:Object.fromEntries(Object.entries(style).filter(([key])=>!['id','text','kind'].includes(key)))};
      if(entry)Object.assign(entry,next);
      else target.texts.push({id:entryId,speakerId:null,...next});
    }
  }
  return episode===source?update:projectNameEpisode({...update,nameEpisodes:{...before.nameEpisodes,[id]:validateEpisode(episode)}},episode);
}

export function editProjectNameScene(project, episodeId, sceneId, operations) {
  const id = episodeKey(project.workId, episodeId), old = project.nameEpisodes?.[id];
  if (!old) throw Error('話のネームがありません');
  return commitNameEpisode(project, editNameScene(old, sceneId, operations), '共通設定変更');
}

export function saveNameRevision(project, episodeId, reason = '手動で版を保存') {
  const id = episodeKey(project.workId, episodeId), current = project.nameEpisodes?.[id];
  if (!current) throw Error('話のネームがありません');
  return { ...project, nameRevisions: { ...(project.nameRevisions ?? {}), [id]: [ ...(project.nameRevisions?.[id] ?? []), nameRevision(current, reason) ] } };
}

export function registerNameReference(project, episodeId, assetKey, role, image) {
  if(!['costume','background','composition'].includes(role)||typeof assetKey!=='string'||!assetKey.trim())throw Error('参照画像の役割・キーが不正です');
  const id=referenceKey(project.workId,episodeId,assetKey,role);
  return {...project,nameReferences:{...(project.nameReferences??{}),[id]:{id,key:assetKey,role,workId:project.workId,episodeId,image}}};
}

export function restoreProjectNameRevision(project, episodeId, revisionId) {
  const id = episodeKey(project.workId, episodeId), current = project.nameEpisodes?.[id], revision = project.nameRevisions?.[id]?.find(item => item.id === revisionId);
  if (!current || !revision) throw Error('復元する話の版がありません');
  const restored = restoreNameRevision(current, revision);
  const next = commitNameEpisode(project, restored, '版の復元前');
  return saveNameRevision(next, episodeId, `版 ${revisionId} から復元`);
}
