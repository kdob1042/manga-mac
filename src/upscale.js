import {artPoints,bounds,contentBox,PAGE} from './layout.js';
import {coverCrop,cropRect} from './image-crop.js';
import {beginJob,finishJob,adoptCandidate,abandonJob} from './revisions.js';
import {placementKey} from './placement.js';
export {placementKey} from './placement.js';
export function upscaleSize(width,height,factor) {
  if(![2,4].includes(factor)||![width,height].every(n=>Number.isInteger(n)&&n>0)||width*factor>4096||height*factor>4096||width*height*factor*factor>16777216)throw Error('拡大は2倍・4倍、最大4096px・1600万画素までです');
  return {width:width*factor,height:height*factor};
}
export function requiredScale(project,id,width,height) {
  const slot=project.layout.pages.flatMap(p=>p.slots).find(s=>s.panelId===id);
  if(!slot)throw Error('コマをページに配置してください');
  const pts=artPoints(slot),b=bounds(pts),box={x:0,y:0,width:b.width*PAGE.width,height:b.height*PAGE.height};
  const cover=coverCrop(project.layout.imageCrops?.[id]);
  if(cover)return cropRect(width,height,box,cover).scale;
  const inner=contentBox(pts);
  return Math.min(inner.width/720,inner.height/1030)*Math.min(716/width,716/height);
}
export async function beginUpscale(project,id,width,height,factor) {
  const size=upscaleSize(width,height,factor),panel=project.panels.find(p=>p.id===id);
  if(!panel?.image)throw Error('作画済みのコマを選択してください');
  const job=await beginJob(project,panel,'upscale');
  return {...job,placement_key:placementKey(project,id),upscale:{method:'canvas-high-quality-interpolation',factor,sourceWidth:width,sourceHeight:height,...size}};
}
export async function finishUpscale(project,job,panel,image) {
  return finishJob(project,job,{...panel,image,upscale:{...job.upscale,parent:job.base_revision}},false,true);
}
export async function adoptUpscale(project,id) {
  const job=project.jobs.find(j=>j.id===id);
  if(job?.kind!=='upscale'||job.placement_key!==placementKey(project,job.panelId))throw Error('配置が変わったため、この候補は採用できません');
  return adoptCandidate(project,id);
}
export const discardUpscale=abandonJob;
