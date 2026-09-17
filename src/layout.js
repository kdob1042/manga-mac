// Shared page geometry. Clockwise convex quadrilaterals in normalized page space.
import {validateCrop} from './image-crop.js';
export const PAGE = { width: 1600, height: 2260 };
const cross = (a,b,c) => (b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
export function validQuad(points) {
  return Array.isArray(points) && points.length === 4 && points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
    && points.every((p,i) => Math.hypot(p[0]-points[(i+1)%4][0],p[1]-points[(i+1)%4][1]) >= .005 && cross(p,points[(i+1)%4],points[(i+2)%4]) > .00001);
}
export function bounds(points) {
  const xs=points.map(p=>p[0]), ys=points.map(p=>p[1]);
  const x=Math.min(...xs),y=Math.min(...ys); return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
}
export function inside(p,points) { return points.every((a,i)=>cross(a,points[(i+1)%4],p)>=-1e-9); }
export function overlaps(a,b) {
  return ![a,b].some(poly=>poly.some((p,i)=>{
    const q=poly[(i+1)%4], axis=[-(q[1]-p[1]),q[0]-p[0]], project=v=>v[0]*axis[0]+v[1]*axis[1];
    const aa=a.map(project),bb=b.map(project);return Math.max(...aa)<=Math.min(...bb)+1e-9 || Math.max(...bb)<=Math.min(...aa)+1e-9;
  }));
}
export function template(count, panelIds=[]) {
  if(!Number.isInteger(count)||count<1||count>16) throw Error('1〜16枠で指定してください');
  const cols=count===1?1:2, rows=Math.ceil(count/cols);
  return Array.from({length:count},(_,i)=>{
    // The four-slot template exactly preserves the old 1600x2260 layout.
    const x=cols===1?60: i%2===0?820:60, y=60+Math.floor(i/cols)*(2160/rows);
    const w=cols===1?1480:720,h=2160/rows-50;
    return {id:crypto.randomUUID(),panelId:panelIds[i]??null,points:[[x/1600,y/2260],[(x+w)/1600,y/2260],[(x+w)/1600,(y+h)/2260],[x/1600,(y+h)/2260]]};
  });
}
export function initialLayout(panels) {
  const pages=[];
  for(let i=0;i<panels.length;i+=4) pages.push({id:crypto.randomUUID(),slots:template(4,panels.slice(i,i+4).map(p=>p.id)).slice(0,Math.min(4,panels.length-i))});
  return {version:1,pages,knownPanelIds:panels.map(p=>p.id)};
}
export function validateLayout(layout,panels) {
  if(!layout || layout.version!==1 || !Array.isArray(layout.pages) || layout.pages.length>1000) throw Error('ページ情報が不正です');
  const known=new Set(panels.map(p=>p.id)), pages=new Set(), slots=new Set(), assigned=new Set();
  if(layout.imageCrops!==undefined) {
    if(!layout.imageCrops || typeof layout.imageCrops!=='object' || Array.isArray(layout.imageCrops))throw Error('画像配置が不正です');
    Object.values(layout.imageCrops).forEach(validateCrop);
  }
  for(const page of layout.pages) {
    if(typeof page.id!=='string'||!page.id||pages.has(page.id)||!Array.isArray(page.slots)||page.slots.length>16) throw Error('ページ情報が不正です'); pages.add(page.id);
    for(const slot of page.slots) {
      if(typeof slot.id!=='string'||!slot.id||slots.has(slot.id)||!validQuad(slot.points)) throw Error('コマ枠はページ内の時計回りの凸四角形にしてください'); slots.add(slot.id);
      if(slot.panelId!==null) { if(!known.has(slot.panelId)||assigned.has(slot.panelId)) throw Error('コマ参照の欠落・重複があります');assigned.add(slot.panelId); }
    }
  }
  return layout;
}
export function ensureLayout(project) {
  if(!project.layout) return {...project,layout:initialLayout(project.panels),layoutHistory:[],layoutRedo:[]};
  const known=new Set(project.panels.map(p=>p.id)), old=new Set(project.layout.knownPanelIds??[]);
  const layout=structuredClone(project.layout);
  // Migrate the superseded per-page lock without retaining it as persisted state.
  layout.pages.forEach(page=>{delete page.locked;page.slots.forEach(slot=>{if(slot.panelId!==null&&!known.has(slot.panelId))slot.panelId=null;});});
  const added=project.panels.filter(p=>!old.has(p.id));
  layout.pages.push(...initialLayout(added).pages); layout.knownPanelIds=[...known];
  validateLayout(layout,project.panels);
  return {...project,layout,layoutHistory:project.layoutHistory??[],layoutRedo:project.layoutRedo??[]};
}
export function layoutWarnings(layout,panels) {
  validateLayout(layout,panels); const warnings=[], assigned=[];
  layout.pages.forEach((page,i)=>{
    if(!page.slots.length) warnings.push(`ページ${i+1}が空です`);
    page.slots.forEach((s,j)=>{if(s.panelId===null)warnings.push(`ページ${i+1}・枠${j+1}が未割当です`);else assigned.push(s.panelId);
      page.slots.slice(j+1).forEach(t=>{if(overlaps(s.points,t.points))warnings.push(`ページ${i+1}の枠${j+1}が重なっています`);});});
  });
  const missing=panels.filter(p=>!assigned.includes(p.id)); if(missing.length)warnings.push(`未割当コマ: ${missing.map(p=>p.id).join(', ')}`);
  const expected=panels.filter(p=>assigned.includes(p.id)).map(p=>p.id);
  if(JSON.stringify(expected)!==JSON.stringify(assigned))warnings.push('ページ割当が原文の読書順と異なります');
  return warnings;
}
function assignedIds(page) { return page.slots.filter(s=>s.panelId!==null).map(s=>s.panelId); }
// Reflow page assignment from one boundary through the end. Pages before the start are immutable.
// Local geometry/crop edits never call this function; pagination changes do.
export function reflowLayout(project,layout=project.layout,startPageIndex=0) {
  validateLayout(layout,project.panels);
  if(!Number.isInteger(startPageIndex)||startPageIndex<0||startPageIndex>=layout.pages.length)throw Error('詰め直しを開始するページが不正です');
  const order=project.panels.map(p=>p.id), next=structuredClone(layout);
  const output=next.pages.slice(0,startPageIndex), prefix=output.flatMap(assignedIds);
  if(JSON.stringify(prefix)!==JSON.stringify(order.slice(0,prefix.length)))throw Error('開始ページより前の割当が原文順ではありません。前のページから詰め直してください');
  const ids=order.slice(prefix.length);let at=0;
  for(const page of next.pages.slice(startPageIndex)) {
    if(at>=ids.length)break;
    const take=Math.min(page.slots.length,ids.length-at);
    if(!take)continue;
    const slots=page.slots.slice(0,take).map((slot,i)=>({...slot,panelId:ids[at+i]}));
    output.push({...page,slots});at+=take;
  }
  while(at<ids.length) {
    const take=Math.min(4,ids.length-at),panelIds=ids.slice(at,at+take);
    output.push({id:crypto.randomUUID(),slots:template(take,panelIds)});at+=take;
  }
  next.pages=output;next.knownPanelIds=[...order];
  validateLayout(next,project.panels);
  const warnings=layoutWarnings(next,project.panels);
  if(warnings.length)throw Error(`後続の詰め直しに失敗しました: ${warnings.join(' / ')}`);
  return next;
}
export function changeLayout(project,layout,label='コマ割り変更') {
  validateLayout(layout,project.panels);
  let next=layout;
  // Slot-capacity changes move a page boundary, so reflow from the first changed page.
  // Pure geometry/crop edits keep every page assignment byte-equivalent.
  const changed=layout.pages.findIndex((page,i)=>project.layout?.pages?.[i]?.id===page.id&&project.layout.pages[i].slots.length!==page.slots.length);
  if(changed>=0)next=reflowLayout(project,layout,changed);
  return {...project,layout:structuredClone(next),layoutHistory:[...(project.layoutHistory??[]),{layout:project.layout,label}].slice(-100),layoutRedo:[]};
}
export function undoLayout(project,redo=false) {
  const from=redo?'layoutRedo':'layoutHistory',to=redo?'layoutHistory':'layoutRedo', entry=project[from]?.at(-1);
  if(!entry)return project; validateLayout(entry.layout,project.panels);
  return {...project,layout:entry.layout,[from]:project[from].slice(0,-1),[to]:[...(project[to]??[]),{layout:project.layout,label:entry.label}]};
}
export function pagePanels(project,page) {return (page?.slots??[]).filter(s=>s.panelId!==null).map(s=>project.panels.find(p=>p.id===s.panelId)).filter(Boolean);}
// Fit the existing square image + lettering composition into an inscribed rectangle.
// No projective warping. For legacy rectangles these coordinates are identical.
export function contentBox(points) {
  const b=bounds(points),cx=b.x+b.width/2,cy=b.y+b.height/2;
  let scale=1;
  while(scale>.01) {
    const w=b.width*scale,h=b.height*scale;
    if([[cx-w/2,cy-h/2],[cx+w/2,cy-h/2],[cx+w/2,cy+h/2],[cx-w/2,cy+h/2]].every(p=>inside(p,points)))return Object.fromEntries(Object.entries({x:(cx-w/2)*1600,y:(cy-h/2)*2260,width:w*1600,height:h*2260}).map(([k,v])=>[k,Math.round(v*1e8)/1e8]));
    scale-=.01;
  }
  throw Error('コマ内の文字領域が不足しています');
}
export function assertLegacyLiveLayout(project) {
  if(!project.layout)return;
  if(Object.keys(project.layout.imageCrops??{}).length)throw Error('Live Manga v1は画像トリミング未対応です。PNG／CBZで書き出してください');
  validateLayout(project.layout,project.panels);
  const geometry=l=>l.pages.map(p=>p.slots.map(({panelId,points})=>({panelId,points})));
  if(JSON.stringify(geometry(project.layout))!==JSON.stringify(geometry(initialLayout(project.panels))))throw Error('Live Manga v1は従来の4コマ配置だけに対応しています。自由コマ割りはPNG／CBZで書き出してください');
}
