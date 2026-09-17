import { validateLayout, PAGE } from './layout.js';
import { frameRect, panelArtRect } from './page-art.js';
import { panelHasText } from './core.js';
import { panelSceneTags } from './source-tags.js';
import { textForPanel } from './localization.js';
import { motionStatus } from './panel-motion.js';
import { validate, VERSION } from '../vendor/live-manga/contracts/validate.mjs';
import { validatePreview, PREVIEW_VERSION } from '../vendor/live-manga/contracts/preview.mjs';

// Capture runs at the writer's save boundary, never around rendering or network I/O.
export function capturePreview(writer, current, capture) {
  return writer.exclusive(async () => {
    const project = structuredClone(current());
    const receipt = await capture(project.revision);
    return { project, ...receipt };
  });
}
export function previewContentKey(project){
  return JSON.stringify({workId:project.workId,title:project.title,active:project.active,locale:project.output_locale,layout:project.layout,panels:project.panels,panelMotions:project.panelMotions,localizations:project.localizations,snapshots:project.snapshots.map(s=>({id:s.id,episodeId:s.episodeId,scenes:s.scenes.map(scene=>({id:scene.id,text:scene.text,tags:scene.tags??s.manifest?.scenes?.find(x=>x.id===scene.id)?.tags}))}))},(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
}

// Dependencies keep canvas and native media outside the immutable projection.
export async function preparePreview(captured, { image, layers, placeholder, probeVideo }) {
  const { project, revision, savedAt } = captured;
  const layout = project.layout;
  if(!layout?.pages.some(p=>p.slots.length))throw Error('表示できる保存済みページがありません');
  validateLayout(layout, project.panels);
  const assets = new Map(), sources = {}, rows = [], pages = [];
  async function addImage(data) {
    const asset = await image(data);
    assets.set(asset.id, asset); sources[asset.id] = { image: data };
    return asset;
  }
  const assigned=new Set(layout.pages.flatMap(p=>p.slots.map(s=>s.panelId)));
  const projection = panelSceneTags(project, project.panels.filter(p=>assigned.has(p.id))), scenes = new Map();
  for (const row of projection) for (const scene of row.scenes) {
    const previous = scenes.get(scene.id);
    scenes.set(scene.id, previous && JSON.stringify(previous.tags) !== JSON.stringify(scene.tags) ? {id:scene.id,tags:[]} : scene);
  }
  for (const layoutPage of layout.pages) {
    if(!layoutPage.slots.length)continue;
    const page = {id:layoutPage.id,...PAGE,panels:[]}, rendered = [];
    for (const slot of layoutPage.slots) {
      const p = project.panels.find(p => p.id === slot.panelId)??{id:`preview-slot:${slot.id}`,sourceRefs:[],image:null};
      const art = p.image ? 'ready' : 'pending';
      const lettering = !panelHasText(p) ? 'none' : p.lettering ? 'ready' : 'pending';
      const poster = await addImage(p.image || await placeholder());
      const snapshot = project.snapshots.find(s => s.id === p.snapshotId);
      const localization = project.output_locale === 'en' ? project.localizations?.find(l => l.snapshot_id === p.snapshotId && l.locale === 'en') : null;
      const text = lettering === 'none' ? '' : textForPanel(p,p.sourceRefs ? project.snapshots : snapshot,p.sourceRefs && project.output_locale === 'en' ? project.localizations : localization);
      const panel = {id:p.id,frame:frameRect(slot.points),clip:slot.points.map(([x,y])=>[x*PAGE.width,y*PAGE.height]),artRect:panelArtRect(slot.points,poster.width,poster.height,layout.imageCrops?.[p.id]),poster:poster.id,text};
      const status = await motionStatus(project,p);
      let motion = status.state === 'stale' ? 'stale' : 'none';
      if (status.revision && art === 'ready') {
        try {
          const v = status.revision, meta = await probeVideo(v.id);
          const asset = {id:v.artifact.hash,path:`assets/${v.artifact.hash}.mp4`,sha256:v.artifact.hash,mime:'video/mp4',bytes:v.artifact.size,...meta};
          assets.set(asset.id,asset); sources[asset.id] = {videoRevision:v.id};
          panel.motion = {asset:asset.id,end:'poster'}; motion = 'ready';
        } catch { motion = 'pending'; }
      }
      rows.push({id:p.id,sceneIds:projection.find(r=>r.panelId===p.id)?.scenes.map(s=>s.id)??[],art,lettering,motion});
      // Pending lettering is explicitly absent from the rendered preview, not silently accepted.
      rendered.push({...p,image:sources[poster.id].image,previewLetteringPending:lettering==='pending'});
      page.panels.push(panel);
    }
    const renderPage={...layoutPage,slots:layoutPage.slots.map((s,i)=>({...s,panelId:rendered[i].id}))};
    for (const [name,layer] of [['art','art'],['overlay','overlay'],['fallback','complete']]) page[name]=(await addImage(await layers(rendered,project,layer,renderPage,layout.imageCrops??{}))).id;
    pages.push(page);
  }
  const active = project.snapshots.find(s=>s.id===project.active);
  const manifest = validate({format:'live-manga',schemaVersion:VERSION,releaseId:revision,workId:project.workId,episodeId:active?.episodeId || 'publication',title:project.title||'漫画',language:project.output_locale??'ja',pages,assets:[...assets.values()]});
  return {preview:validatePreview({format:'live-manga-preview',schemaVersion:PREVIEW_VERSION,savedAt,manifest,scenes:[...scenes.values()],panels:rows}),sources};
}

// Fixed envelope and base revision survive retries; only missing verified bytes are resent.
export async function transferPreview({preview,baseRevision,request,upload,onStatus=()=>{}}) {
  validatePreview(preview);
  const m=preview.manifest, path=`/previews/${m.workId}/${m.episodeId}/transfers/${m.releaseId}`;
  onStatus('transferring');
  await request('PUT',path,{preview,baseRevision});
  let state=await request('GET',path);
  if (!state.committed) {
    for(const id of state.missing) {
      const asset=m.assets.find(a=>a.id===id);
      if(!asset)throw Error('受信側が不明なアセットを要求しました');
      await upload(`${path}/${asset.path}`,asset);
    }
    onStatus('verifying');
    try { await request('POST',`${path}/commit`); }
    catch(error) { state=await request('GET',path);if(!state.committed)throw error; }
    state=await request('GET',path);
  }
  if(!state.committed || state.transferId!==m.releaseId)throw Error('転送の確定を確認できません');
  onStatus('sent');return state;
}
