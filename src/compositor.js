import {beginJob, finishJob} from './revisions.js';

export const compositorRevision = 'c39da13b5db11bc8678ec04a7a748e1e0a589244';
export function rasterBundle(image, width, height, ids = [crypto.randomUUID(), crypto.randomUUID()]) {
  if (!image?.startsWith('data:image/png;base64,') || ![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=30000) || width*height>100000000) throw Error('PNGと有効なキャンバス寸法が必要です');
  const [documentID, layerID] = ids.map(id=>id.toUpperCase());
  return {manifest:{format:'com.compositor.project',version:8,colorSpace:'sRGB',documentID,width,height,activeLayerID:layerID,
    layers:[{id:layerID,name:'原画',isVisible:true,transform:{origin:[0,0],size:[width,height],rotation:0,flipX:false,flipY:false,sampling:'High quality'},imageFile:`${layerID}.png`}]}, images:{[`${layerID}.png`]:{image}}};
}
export async function beginCompositor(project, panel) {
  if (!panel.image) throw Error('作画を用意してください');
  const job = await beginJob(project,panel,'compositor');
  // The existing job owns provenance and late-result handling; no second job queue.
  return {...job,recovery:{panel:structuredClone(panel)},compositor:{upstream_revision:compositorRevision,bindings:structuredClone(panel.compositor?.bindings??{})}};
}
export function reconcileBindings(bindings, state, characters) {
  const layers=new Set(state.layers.map(l=>l.id)), people=new Set(characters.map(c=>c.id));
  return Object.fromEntries(Object.entries(bindings).filter(([layer,character])=>layers.has(layer)&&people.has(character)));
}
export async function finishCompositor(project, job, snapshot) {
  if (!snapshot?.image?.startsWith('data:image/png;base64,') || snapshot.upstream_revision!==compositorRevision || snapshot.state?.document!==snapshot.bundle?.manifest?.documentID || !['app','codex'].includes(snapshot.state?.owner)) throw Error('Compositorの保存版と合成画像が一致しません');
  const source=job.recovery?.panel;
  if (!source || source.id!==job.panelId) throw Error('編集元のコマがありません');
  const bindings=reconcileBindings(job.compositor.bindings,snapshot.state,project.characters);
  const generated={...source,image:snapshot.image,status:'review',compositor:{bundle:snapshot.bundle,bindings,document:snapshot.state.document,revision:snapshot.state.revision,upstream_revision:compositorRevision,includes_unsaved_changes:snapshot.includes_unsaved_changes===true}};
  // Even unchanged input requires explicit adoption of this external-editor candidate.
  return finishJob(project,job,generated,false,true);
}
export function operation(state, op, args={}) {
  if (!state?.document || !Number.isSafeInteger(state.revision) || !['app','human','codex'].includes(state.owner)) throw Error('Compositorの状態を再取得してください');
  return {...args,op,instance:state.instance,document:state.document,revision:state.revision};
}
