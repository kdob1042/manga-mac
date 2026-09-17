// Thin orchestration shared by manual controls and natural-language commands.
import { imageOf } from './render';
import { beginFinishing, finishingPlan, finishingInstruction } from './finishing.js';
import { beginUpscale, finishUpscale } from './upscale.js';
import { generatePanel } from './pipeline';
import { finishJob } from './revisions.js';
import { shotFromPanel, assignMotion } from './panel-motion.js';
export async function checkPanelAction(project,op) {
  const source=project.panels.find(p=>p.id===op.panelId);
  if(['finishing','upscale','resolution'].includes(op.kind)) {
    const im=await imageOf(source.image);
    if(op.kind==='finishing')await beginFinishing(project,op.panelId,im.width,im.height);
    else if(op.kind==='upscale')await beginUpscale(project,op.panelId,im.width,im.height,op.args.factor);
    else finishingPlan(project,op.panelId,im.width,im.height);
  }
  if(op.kind==='video_prepare')await shotFromPanel(project,op.panelId,op.args.instruction,op.args.ratio);
  if(op.kind==='video_assign')await assignMotion(project,op.panelId,op.args.shotId);
}
export async function prepareFinishing(current,commit,id) {
  const p=current(),source=p.panels.find(x=>x.id===id),im=await imageOf(source.image),job=await beginFinishing(p,id,im.width,im.height);
  await commit({...p,jobs:[...p.jobs,job]});
  try {const result=await generatePanel(source,p.characters,source.image,finishingInstruction(job),job,null,p.style_references??[]);await commit(await finishJob(current(),job,result,false,true));}
  catch(e){await commit({...current(),jobs:current().jobs.map(j=>j.id===job.id?{...j,status:'unknown'}:j)});throw e;}
}
export async function prepareInterpolation(current,commit,id,factor) {
  const p=current(),source=p.panels.find(x=>x.id===id),im=await imageOf(source.image),job=await beginUpscale(p,id,im.width,im.height,factor);
  await commit({...p,jobs:[...p.jobs,job]});
  try {
    const canvas=document.createElement('canvas');canvas.width=job.upscale.width;canvas.height=job.upscale.height;
    const ctx=canvas.getContext('2d');if(!ctx)throw Error('画像処理を開始できません');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(im,0,0,canvas.width,canvas.height);
    const image=canvas.toDataURL('image/png');if(!image.startsWith('data:image/png;base64,'))throw Error('画像を保存できません');
    await commit(await finishUpscale(current(),job,source,image));
  }catch(e){await commit({...current(),jobs:current().jobs.map(j=>j.id===job.id?{...j,status:'failed'}:j)});throw e;}
}
export async function panelAction(current,commit,op,onShot) {
  if(op.kind==='finishing'){await prepareFinishing(current,commit,op.panelId);return '仕上げ候補を保存しました。対象コマで比較して採用してください';}
  if(op.kind==='upscale'){await prepareInterpolation(current,commit,op.panelId,op.args.factor);return '補間拡大候補を保存しました。細部を生成するAI超解像ではありません';}
  if(op.kind==='resolution') {
    const p=current(),source=p.panels.find(p=>p.id===op.panelId),im=await imageOf(source.image),plan=finishingPlan(p,op.panelId,im.width,im.height);
    return `元画像 ${im.width}×${im.height}px／必要 ${plan.requiredWidth}×${plan.requiredHeight}px。${plan.sourceSufficient?'画素数は足りています':'現在の配置では画素数が不足しています'}`;
  }
  if(op.kind==='video_prepare'){const next=await shotFromPanel(current(),op.panelId,op.args.instruction,op.args.ratio);await commit(next);onShot(next.videoShots.at(-1).id);return '動画の準備を保存しました。動画画面の既存許可・予算設定から生成できます（生成APIはまだ呼んでいません）';}
  if(op.kind==='video_assign'){await commit(await assignMotion(current(),op.panelId,op.args.shotId));return '保存済み動画を割り当てました。新規生成はしていません';}
  throw Error('未対応の操作です');
}
