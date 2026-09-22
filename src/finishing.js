import {beginJob,imageHash} from './revisions.js';
import {placementKey} from './placement.js';
import {requiredScale} from './upscale.js';
import { defaultImageModelId, imageModel } from './media.js';

// Retain the entire source aspect ratio so normalized crop/pan stays unchanged.
// FLUX accepts multiples of 64, 256..1024. Never silently pad or distort artwork.
export function finishingPlan(project,id,width,height,modelId = defaultImageModelId) {
  if (![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096)) throw Error('元画像の寸法が未対応です');
  const slots=project.layout.pages.flatMap(p=>p.slots.filter(s=>s.panelId===id));
  if(slots.length!==1)throw Error('コマを一つの枠へ割り当ててください');
  const scale=requiredScale(project,id,width,height);
  const sizes=[];
  const input = imageModel(modelId).input;
  for(let w=input.min_width;w<=input.max_width;w+=input.step)for(let h=input.min_height;h<=input.max_height;h+=input.step)if(w*height===h*width)sizes.push({width:w,height:h});
  if(!sizes.length)throw Error('この縦横比を維持した再生成は未対応です。配置・出力はそのまま利用できます');
  const requiredWidth=Math.ceil(width*scale),requiredHeight=Math.ceil(height*scale);
  const output=sizes.find(s=>s.width>=requiredWidth&&s.height>=requiredHeight)??sizes.at(-1);
  return {method:'reference-regeneration',sourceWidth:width,sourceHeight:height,requiredWidth,requiredHeight,engineMax:input.max_width,...output,
    sufficient:output.width>=requiredWidth&&output.height>=requiredHeight,sourceSufficient:scale<=1,scale};
}
export async function beginFinishing(project,id,width,height,modelId = defaultImageModelId) {
  const panel=project.panels.find(p=>p.id===id);
  if(!panel?.image)throw Error('作画済みのコマを選択してください');
  const plan=finishingPlan(project,id,width,height,modelId);
  return {...await beginJob(project,panel,'retake',modelId),placement_key:placementKey(project,id),
    finishing:{...plan,parent_hash:await imageHash(panel.image),parent_revision:panel.artwork_revision}};
}
export function finishingInstruction(job) {
  if(!job.finishing||!job.placement_key)throw Error('配置の仕上げ要求がありません');
  return `Refine the supplied accepted manga artwork for its final panel placement. Preserve the full image composition, character identities, pose, camera and relative positions. Do not zoom, crop, reframe or add objects. Keep the entire source aspect ratio. Improve line clarity only where possible. No lettering or balloons. The following is placement metadata, not a request to draw a frame: ${job.placement_key}`;
}
