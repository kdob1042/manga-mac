import {containRect} from './image-input.js';
import {cropRect} from './image-crop.js';
import {bounds,contentBox,PAGE,inside} from './layout.js';

export const visualSchema={type:'object',properties:{uncertain:{type:'boolean'},reason:{type:'string'},regions:{type:'array',maxItems:32,items:{type:'object',properties:{panelId:{type:'string'},purpose:{type:'string',enum:['edit','avoid','subject']},label:{type:'string'},rect:{type:'array',minItems:4,maxItems:4,items:{type:'number'}}},required:['panelId','purpose','label','rect'],additionalProperties:false}}},required:['uncertain','reason','regions'],additionalProperties:false};
export function validRegion(r) {return Array.isArray(r)&&r.length===4&&r.every(Number.isFinite)&&r[0]>=0&&r[1]>=0&&r[2]>.001&&r[3]>.001&&r[0]+r[2]<=1&&r[1]+r[3]<=1;}
export async function recognizeRegions(project,ids,instruction,ask,dimensions) {
  const panels=ids.map(id=>project.panels.find(p=>p.id===id));
  if(!panels.length||panels.length>8||panels.some(p=>!p?.image))throw Error('画像のある対象コマを8件以内で指定してください');
  const result=JSON.parse(await ask(JSON.stringify({task:'添付画像の順番はpanelsと一致。画像原本の左上0,0、右下1,1で対象矩形[x,y,width,height]を特定する。指示が部分修正なら変更対象だけをedit、文字回避なら顔・手・重要描写をavoid、しっぽや切れないcropなら対象人物/頭をsubjectとする。人物対応が不明、対象が見えない、画像を読めない場合はuncertain=true、regions=[]。推測だけで成功にしない。自由な描き直しや操作計画は返さない。',instruction,panels:panels.map(p=>({id:p.id,characters:p.characterIds.map(id=>{const c=project.characters.find(c=>c.id===id);return {id,name:c?.name,description:c?.description};})}))}),visualSchema,panels.map(p=>p.image)));
  if(result.uncertain!==false||typeof result.reason!=='string'||!Array.isArray(result.regions)||!result.regions.length||result.regions.length>32)throw Error('画像内の対象を特定できません。対象を選ぶか範囲を手動で指定してください');
  for(const r of result.regions)if(!ids.includes(r.panelId)||!['edit','avoid','subject'].includes(r.purpose)||typeof r.label!=='string'||!r.label.trim()||!validRegion(r.rect))throw Error('画像の認識範囲が不正です');
  const sizes={};for(const p of panels){const im=await dimensions(p.image);sizes[p.id]={width:im.width,height:im.height};}
  return {regions:result.regions,sizes,reason:result.reason};
}
function geometry(project,id,size) {
  if(!size||![size.width,size.height].every(n=>Number.isFinite(n)&&n>0))throw Error('元画像の寸法がありません');
  const slot=project.layout.pages.flatMap(p=>p.slots).find(s=>s.panelId===id);
  if(!slot)throw Error('対象のコマ枠がありません');
  const box=contentBox(slot.points),scale=Math.min(box.width/720,box.height/1030);
  const letters={x:box.x+(box.width-720*scale)/2+2*scale,y:box.y+(box.height-1030*scale)/2+2*scale,width:716*scale,height:716*scale};
  const crop=project.layout.imageCrops?.[id],b=bounds(slot.points);
  const fitted=containRect(size.width,size.height,letters.width,letters.height);
  const image=crop?cropRect(size.width,size.height,{x:b.x*PAGE.width,y:b.y*PAGE.height,width:b.width*PAGE.width,height:b.height*PAGE.height},crop):{...fitted,x:letters.x+fitted.x,y:letters.y+fitted.y};
  return {letters,image,slot};
}
export function letteringRegions(project,id,visual) {
  const {letters,image}=geometry(project,id,visual.sizes[id]);
  return visual.regions.filter(r=>r.panelId===id).map(r=>({...r,rect:[(image.x+r.rect[0]*image.width-letters.x)/letters.width,(image.y+r.rect[1]*image.height-letters.y)/letters.height,r.rect[2]*image.width/letters.width,r.rect[3]*image.height/letters.height]}));
}
export function checkVisualEdit(project,op,visual) {
  if(!visual)return;
  const relevant=visual.regions.filter(r=>r.panelId===op.panelId);
  if(!relevant.length)return;
  if(op.kind==='lettering'&&op.args.mode==='balloons') {
    const regions=letteringRegions(project,op.panelId,visual);
    for(const b of op.args.boxes)for(const r of regions.filter(r=>r.purpose==='avoid')) {
      const [x,y,w,h]=r.rect;
      if(b.x<x+w&&b.x+b.width>x&&b.y<y+h&&b.y+b.height>y)throw Error('文字枠が認識した重要領域に重なっています。配置を調整してください');
    }
  }
  if(op.kind==='crop') {
    const {image,slot}=geometry(project,op.panelId,visual.sizes[op.panelId]);
    for(const r of relevant.filter(r=>r.purpose==='subject')) {
      const [x,y,w,h]=r.rect;
      if([[x,y],[x+w,y],[x+w,y+h],[x,y+h]].some(([a,b])=>!inside([(image.x+a*image.width)/PAGE.width,(image.y+b*image.height)/PAGE.height],slot.points)))throw Error('対象がコマ枠で切れる配置です。倍率・枠を調整してください');
    }
  }
}
export function regionForEdit(context,id) {
  if(context.selected===id&&validRegion(context.region))return context.region;
  const candidates=context.visual?.regions.filter(r=>r.panelId===id&&r.purpose==='edit')??[];
  if(candidates.length!==1)throw Error('変更範囲を一つに特定するか、手動で指定してください');
  return candidates[0].rect;
}
