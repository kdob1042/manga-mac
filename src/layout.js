// Shared page geometry. Clockwise convex quadrilaterals in normalized page space.
import {validateCrop} from './image-crop.js';
import {removeLegacyConfirmation} from './legacy-confirmation.js';
import {defaultLettering} from './lettering.js';
import {panelHasText} from './core.js';
export const PAGE = { width: 1600, height: 2260 };
const cross = (a,b,c) => (b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
export function validQuad(points) {return Array.isArray(points)&&points.length===4&&points.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&v>=0&&v<=1))&&points.every((p,i)=>Math.hypot(p[0]-points[(i+1)%4][0],p[1]-points[(i+1)%4][1])>=.005&&cross(p,points[(i+1)%4],points[(i+2)%4])>.00001);}
export function bounds(points){const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const x=Math.min(...xs),y=Math.min(...ys);return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};}
export function resizeQuadEdge(points,edge,delta){
 const result=points.map(point=>[...point]),first=points[edge],second=points[(edge+1)%4];
 const ex=(second[0]-first[0])*PAGE.width,ey=(second[1]-first[1])*PAGE.height,length=Math.hypot(ex,ey);
 if(!length)return result;
 const nx=-ey/length,ny=ex/length;
 const distance=delta[0]*PAGE.width*nx+delta[1]*PAGE.height*ny;
 // Slide the edge along its neighbours. Translating both corners along the
 // normal would pull a slanted edge away from the page's top/bottom margin.
 for(const [index,other] of [[edge,(edge+3)%4],[(edge+1)%4,(edge+2)%4]]){
  const dx=(points[index][0]-points[other][0])*PAGE.width,dy=(points[index][1]-points[other][1])*PAGE.height;
  const projection=dx*nx+dy*ny;
  if(Math.abs(projection)<1e-8)return points.map(point=>[...point]);
  result[index][0]+=distance*dx/projection/PAGE.width;
  result[index][1]+=distance*dy/projection/PAGE.height;
 }
 return result;
}

// Shared by the art proof and layout editor. All tolerances are CSS pixels,
// independent of page zoom. This function never mutates the saved slot.
export function dragSlotFrame(slot,{edge=null,vertex=null},delta,{page,width,height,snap=true}){
 const size=[width,height],original=slot.points,b= bounds(original);
 const minimum=[Math.min(b.width,24/width),Math.min(b.height,24/height)];
 const build=d=>{
  let points=original.map(p=>[...p]),overflow=slot.overflow;
  if(vertex!==null)points[vertex]=points[vertex].map((v,axis)=>v+d[axis]);
  else if(edge!==null)points=resizeQuadEdge(original,edge,d);
  else {
   const all=[...points,...(overflow?.points??[])];
   const shift=d.map((v,axis)=>Math.max(-Math.min(...all.map(p=>p[axis])),Math.min(1-Math.max(...all.map(p=>p[axis])),v)));
   points=points.map(p=>p.map((v,axis)=>v+shift[axis]));
   if(overflow)overflow={...overflow,points:overflow.points.map(p=>p.map((v,axis)=>v+shift[axis]))};
  }
  // Eliminate floating-point spill at an exact page boundary.
  points=points.map(p=>p.map(v=>Math.abs(v)<1e-10?0:Math.abs(v-1)<1e-10?1:v));
  return {...slot,points,...(overflow?{overflow}:{})};
 };
 const acceptable=value=>{
  const box=bounds(value.points);
  return validQuad(value.points)&&box.width>=minimum[0]-1e-9&&box.height>=minimum[1]-1e-9
   &&value.points.every((p,i)=>Math.hypot(...p.map((v,a)=>(v-value.points[(i+1)%4][a])*size[a]))>=Math.min(16,Math.hypot(...original[i].map((v,a)=>(v-original[(i+1)%4][a])*size[a])))-1e-7)
   &&(!value.overflow||value.points.every(p=>inside(p,value.overflow.points)));
 };
 let d=[...delta],result=build(d);
 if(!acceptable(result)){
  let low=0,high=1;
  for(let i=0;i<40;i++){const t=(low+high)/2;if(acceptable(build(delta.map(v=>v*t))))low=t;else high=t;}
  d=delta.map(v=>v*low);result=build(d);
 }
 const targets=[0,1].map(axis=>[...new Set([0,1,...(page?.slots??[slot]).flatMap(s=>s.points.map(p=>p[axis]))])]);
 const indices=vertex!==null?[vertex]:edge!==null?[edge,(edge+1)%4]:[0,1,2,3];
 if(snap){
  if(edge!==null){
   // Edge motion has one degree of freedom. Snap the closest endpoint to a
   // guide without bending the edge or releasing the neighbouring edges.
   const a=original[edge],b=original[(edge+1)%4],ex=(b[0]-a[0])*PAGE.width,ey=(b[1]-a[1])*PAGE.height,len=Math.hypot(ex,ey);
   const unit=[-ey/len/PAGE.width,ex/len/PAGE.height],step=build(d.map((v,i)=>v+unit[i]));
   const options=[];
   for(const i of indices)for(let axis=0;axis<2;axis++){
    const slope=step.points[i][axis]-result.points[i][axis];if(Math.abs(slope)<1e-10)continue;
    for(const target of targets[axis]){
     const distance=(target-result.points[i][axis])*size[axis];if(Math.abs(distance)>6)continue;
     const amount=(target-result.points[i][axis])/slope;
     const candidate=build(d.map((v,j)=>v+amount*unit[j]));
     const travel=Math.max(...indices.map(k=>Math.hypot(...candidate.points[k].map((v,j)=>(v-result.points[k][j])*size[j]))));
     if(travel<=8&&acceptable(candidate))options.push({candidate,travel});
    }
   }
   options.sort((a,b)=>a.travel-b.travel);if(options.length)result=options[0].candidate;
  }else for(let axis=0;axis<2;axis++){
   const options=indices.flatMap(i=>targets[axis].map(target=>target-result.points[i][axis])).filter(v=>Math.abs(v)*size[axis]<=6).sort((a,b)=>Math.abs(a)-Math.abs(b));
   for(const shift of options){const next=[...d];next[axis]+=shift;const candidate=build(next);if(acceptable(candidate)){d=next;result=candidate;break;}}
  }
 }
 // Returning to the original guide is a no-op, including Undo history.
 result.points=result.points.map((p,i)=>p.map((v,axis)=>Math.abs(v-original[i][axis])<1e-10?original[i][axis]:v));
 const guides=snap?targets.flatMap((values,axis)=>values.filter(value=>indices.some(i=>Math.abs(result.points[i][axis]-value)<1e-8)).map(value=>({axis,value}))):[];
 return {slot:result,guides};
}
export function inside(p,points){return points.every((a,i)=>cross(a,points[(i+1)%4],p)>=-1e-9);}
export function overlaps(a,b){return ![a,b].some(poly=>poly.some((p,i)=>{const q=poly[(i+1)%4],axis=[-(q[1]-p[1]),q[0]-p[0]],project=v=>v[0]*axis[0]+v[1]*axis[1];const aa=a.map(project),bb=b.map(project);return Math.max(...aa)<=Math.min(...bb)+1e-9||Math.max(...bb)<=Math.min(...aa)+1e-9;}));}
export function artPoints(slot){return slot.overflow?.points??slot.points;}
export function validateOverflow(slot){
 if(slot.overflow==null)return;
 const o=slot.overflow;
 if(!o||typeof o!=='object'||Array.isArray(o))throw Error('はみ出し配置が不正です');
 if(Object.keys(o).some(k=>!['points','z'].includes(k)))throw Error('はみ出し配置の未対応項目です');
 if(!validQuad(o.points))throw Error('はみ出し領域はページ内の時計回りの凸四角形にしてください');
 if(o.z!==undefined&&(!Number.isInteger(o.z)||o.z<0||o.z>15))throw Error('はみ出しの重ね順は0〜15です');
 if(!slot.points.every(p=>inside(p,o.points)))throw Error('はみ出し領域はホーム枠を含めてください');
}
export function overflowDrawOrder(page){
 return page.slots.map((slot,index)=>({slot,index,z:slot.overflow?.z??0})).filter(x=>x.slot.overflow).sort((a,b)=>a.z-b.z||a.index-b.index);
}
function letteringPageQuads(slot,panel){
 if(!panelHasText(panel))return [];
 const box=contentBox(slot.points),scale=Math.min(box.width/720,box.height/1030);
 const ox=box.x+(box.width-720*scale)/2,oy=box.y+(box.height-1030*scale)/2;
 const quad=(x,y,w,h)=>[[x/PAGE.width,y/PAGE.height],[(x+w)/PAGE.width,y/PAGE.height],[(x+w)/PAGE.width,(y+h)/PAGE.height],[x/PAGE.width,(y+h)/PAGE.height]];
 const layout=panel.lettering??defaultLettering(panel);
 if(panel.namePlanVersion===2 && layout.mode==='balloons')return layout.boxes.map(b=>quad(box.x+b.x*box.width,box.y+b.y*box.height,b.width*box.width,b.height*box.height));
 if(layout.mode==='balloons')return layout.boxes.map(b=>quad(ox+(2+b.x*716)*scale,oy+(2+b.y*716)*scale,b.width*716*scale,b.height*716*scale));
 return [quad(ox+10*scale,oy+736*scale,700*scale,280*scale)];
}
export function template(count,panelIds=[]){if(!Number.isInteger(count)||count<1||count>16)throw Error('1〜16枠で指定してください');const cols=count===1?1:2,rows=Math.ceil(count/cols);return Array.from({length:count},(_,i)=>{const x=cols===1?60:i%2===0?820:60,y=60+Math.floor(i/cols)*(2160/rows),w=cols===1?1480:720,h=2160/rows-50;return {id:crypto.randomUUID(),panelId:panelIds[i]??null,points:[[x/1600,y/2260],[(x+w)/1600,y/2260],[(x+w)/1600,(y+h)/2260],[x/1600,(y+h)/2260]]};});}
export function initialLayout(panels){const pages=[];for(let i=0;i<panels.length;i+=4)pages.push({id:crypto.randomUUID(),slots:template(4,panels.slice(i,i+4).map(p=>p.id)).slice(0,Math.min(4,panels.length-i))});return {version:1,pages,knownPanelIds:panels.map(p=>p.id)};}
export function validateLayout(layout,panels){if(!layout||layout.version!==1||!Array.isArray(layout.pages)||layout.pages.length>1000)throw Error('ページ情報が不正です');const known=new Set(panels.map(p=>p.id)),pages=new Set(),slots=new Set(),assigned=new Set();if(layout.imageCrops!==undefined){if(!layout.imageCrops||typeof layout.imageCrops!=='object'||Array.isArray(layout.imageCrops))throw Error('画像配置が不正です');Object.values(layout.imageCrops).forEach(validateCrop);}for(const page of layout.pages){if(typeof page.id!=='string'||!page.id||pages.has(page.id)||!Array.isArray(page.slots)||page.slots.length>16)throw Error('ページ情報が不正です');pages.add(page.id);for(const slot of page.slots){if(typeof slot.id!=='string'||!slot.id||slots.has(slot.id)||!validQuad(slot.points))throw Error('コマ枠はページ内の時計回りの凸四角形にしてください');slots.add(slot.id);validateOverflow(slot);if(slot.panelId!==null){if(!known.has(slot.panelId)||assigned.has(slot.panelId))throw Error('コマ参照の欠落・重複があります');assigned.add(slot.panelId);}}}return layout;}
export function ensureLayout(project){project=removeLegacyConfirmation(structuredClone(project));if(!project.layout)return {...project,layout:initialLayout(project.panels),layoutHistory:[],layoutRedo:[]};const known=new Set(project.panels.map(p=>p.id)),old=new Set(project.layout.knownPanelIds??[]),layout=structuredClone(project.layout);layout.pages.forEach(page=>{delete page.locked;page.slots.forEach(slot=>{if(slot.panelId!==null&&!known.has(slot.panelId))slot.panelId=null;});});const added=project.panels.filter(p=>!old.has(p.id));layout.pages.push(...initialLayout(added).pages);layout.knownPanelIds=[...known];validateLayout(layout,project.panels);return {...project,layout,layoutHistory:project.layoutHistory??[],layoutRedo:project.layoutRedo??[]};}
export function layoutWarnings(layout,panels){validateLayout(layout,panels);const warnings=[],assigned=[];layout.pages.forEach((page,i)=>{if(!page.slots.length)warnings.push(`ページ${i+1}が空です`);page.slots.forEach((s,j)=>{if(s.panelId===null)warnings.push(`ページ${i+1}・枠${j+1}が未割当です`);else assigned.push(s.panelId);page.slots.slice(j+1).forEach(t=>{if(overlaps(s.points,t.points))warnings.push(`ページ${i+1}の枠${j+1}が重なっています`);});if(s.overflow)page.slots.forEach((t,k)=>{if(k===j||t.panelId===null)return;const other=panels.find(p=>p.id===t.panelId);if(!other)return;if(letteringPageQuads(t,other).some(quad=>overlaps(quad,s.overflow.points)))warnings.push(`ページ${i+1}・枠${j+1}のはみ出しが他コマの文字と重なっています`);});});});const assignedSet=new Set(assigned);const missing=panels.filter(p=>!assignedSet.has(p.id));if(missing.length)warnings.push(`未割当コマ: ${missing.map(p=>p.id).join(', ')}`);const expected=panels.filter(p=>assignedSet.has(p.id)).map(p=>p.id);if(JSON.stringify(expected)!==JSON.stringify(assigned))warnings.push('ページ割当が原文の読書順と異なります');return warnings;}
function assignedIds(page){return page.slots.filter(s=>s.panelId!==null).map(s=>s.panelId);}
export function reflowLayout(project,layout=project.layout,startPageIndex=0){validateLayout(layout,project.panels);if(!Number.isInteger(startPageIndex)||startPageIndex<0||startPageIndex>=layout.pages.length)throw Error('詰め直しを開始するページが不正です');if(JSON.stringify(layout.pages.slice(0,startPageIndex))!==JSON.stringify(project.layout.pages.slice(0,startPageIndex)))throw Error('指定範囲より前のページは変更できません');const order=project.panels.map(p=>p.id),next=structuredClone(layout),output=next.pages.slice(0,startPageIndex),prefix=output.flatMap(assignedIds);if(JSON.stringify(prefix)!==JSON.stringify(order.slice(0,prefix.length)))throw Error('開始ページより前の割当が原文順ではありません。前のページから詰め直してください');const ids=order.slice(prefix.length);let at=0;for(const page of next.pages.slice(startPageIndex)){if(at>=ids.length)break;const take=Math.min(page.slots.length,ids.length-at);if(!take)continue;output.push({...page,slots:page.slots.slice(0,take).map((slot,i)=>({...slot,panelId:ids[at+i]}))});at+=take;}while(at<ids.length){const take=Math.min(4,ids.length-at),panelIds=ids.slice(at,at+take);output.push({id:crypto.randomUUID(),slots:template(take,panelIds)});at+=take;}next.pages=output;next.knownPanelIds=[...order];validateLayout(next,project.panels);const warnings=layoutWarnings(next,project.panels);if(warnings.length)throw Error(`後続の詰め直しに失敗しました: ${warnings.join(' / ')}`);return next;}
export function assertLayoutScope(project,layout,scope) {
  if(!scope || !Array.isArray(scope.pageIds) || new Set(scope.pageIds).size!==scope.pageIds.length || scope.pageIds.some(id=>!project.layout.pages.some(p=>p.id===id))) throw Error('変更対象のページを明示してください');
  const ids=new Set(scope.pageIds), oldIds=new Set(project.layout.pages.map(p=>p.id));
  const outside=project.layout.pages.filter(p=>!ids.has(p.id));
  if(JSON.stringify(outside)!==JSON.stringify(layout.pages.filter(p=>oldIds.has(p.id)&&!ids.has(p.id))))throw Error('対象外のページは変更できません');
  if(!scope.allowPageChanges && JSON.stringify(layout.pages.map(p=>p.id))!==JSON.stringify(project.layout.pages.map(p=>p.id)))throw Error('ページの追加削除は対象外です');
  const panels=new Set(project.layout.pages.filter(p=>ids.has(p.id)).flatMap(p=>p.slots.map(s=>s.panelId)));
  const crops=new Set([...Object.keys(project.layout.imageCrops??{}),...Object.keys(layout.imageCrops??{})]);
  for(const id of crops)if(!panels.has(id)&&JSON.stringify(project.layout.imageCrops?.[id])!==JSON.stringify(layout.imageCrops?.[id]))throw Error('対象外の画像配置は変更できません');
}
export function changeLayout(project,layout,label='コマ割り変更',scope){
  validateLayout(layout,project.panels);assertLayoutScope(project,layout,scope);
  let next=layout;
  if(scope.reflowFrom!==undefined) {
    if(project.layout.pages[scope.reflowFrom]?.id!==scope.pageIds[0])throw Error('詰め直しの開始対象が一致しません');
    next=reflowLayout(project,layout,scope.reflowFrom);
  }
  return {...project,layout:structuredClone(next),layoutHistory:[...(project.layoutHistory??[]),{layout:project.layout,label}].slice(-100),layoutRedo:[]};
}
export function undoLayout(project,redo=false){const from=redo?'layoutRedo':'layoutHistory',to=redo?'layoutHistory':'layoutRedo',entry=project[from]?.at(-1);if(!entry)return project;validateLayout(entry.layout,project.panels);return {...project,layout:entry.layout,[from]:project[from].slice(0,-1),[to]:[...(project[to]??[]),{layout:project.layout,label:entry.label}]};}
export function pagePanels(project,page){return (page?.slots??[]).filter(s=>s.panelId!==null).map(s=>project.panels.find(p=>p.id===s.panelId)).filter(Boolean);}
export function contentBox(points){const b=bounds(points),cx=b.x+b.width/2,cy=b.y+b.height/2;let scale=1;while(scale>.01){const w=b.width*scale,h=b.height*scale;if([[cx-w/2,cy-h/2],[cx+w/2,cy-h/2],[cx+w/2,cy+h/2],[cx-w/2,cy+h/2]].every(p=>inside(p,points)))return Object.fromEntries(Object.entries({x:(cx-w/2)*1600,y:(cy-h/2)*2260,width:w*1600,height:h*2260}).map(([k,v])=>[k,Math.round(v*1e8)/1e8]));scale-=.01;}throw Error('コマ内の文字領域が不足しています');}
export function assertLegacyLiveLayout(project){if(!project.layout)return;if(Object.keys(project.layout.imageCrops??{}).length)throw Error('Live Manga v1は画像トリミング未対応です。PNG／CBZで書き出してください');validateLayout(project.layout,project.panels);const geometry=l=>l.pages.map(p=>p.slots.map(({panelId,points,overflow})=>({panelId,points,overflow:overflow??null})));if(JSON.stringify(geometry(project.layout))!==JSON.stringify(geometry(initialLayout(project.panels))))throw Error('Live Manga v1は従来の4コマ配置だけに対応しています。自由コマ割りはPNG／CBZで書き出してください');}

// Every splice is checked against the same old layout; input is never mutated.
export function layoutSplice(project,start,count,replacementPages){
 const pages=project.layout.pages;
 if(!Number.isInteger(start)||!Number.isInteger(count)||start<0||count<0||start+count>pages.length)throw Error('ページ区間が不正です');
 return {baseContentToken:project.contentToken??JSON.stringify(project.layout),beforePageId:pages[start-1]?.id??null,afterPageId:pages[start+count]?.id??null,oldPageIds:pages.slice(start,start+count).map(p=>p.id),replacementPages:structuredClone(replacementPages)};
}
export function validateLayoutPatch(project,changedPanels,splices,baseContentToken=project.contentToken){
 if(project.contentToken!==baseContentToken)throw Error('配置の基準版が変わりました');
 if(!Array.isArray(splices)||!Array.isArray(changedPanels)||new Set(changedPanels.map(p=>p.id)).size!==changedPanels.length)throw Error('配置パッチが不正です');
 const original=project.layout.pages,inside=new Set();
 const ranges=splices.map(s=>{
  if(s.baseContentToken!==undefined&&s.baseContentToken!==(project.contentToken??JSON.stringify(project.layout)))throw Error('配置の基準版が変わりました');
  if(!Array.isArray(s.oldPageIds)||!Array.isArray(s.replacementPages)||new Set(s.oldPageIds).size!==s.oldPageIds.length)throw Error('ページ区間が不正です');
  const start=s.oldPageIds.length?original.findIndex(p=>p.id===s.oldPageIds[0]):s.beforePageId===null?0:original.findIndex(p=>p.id===s.beforePageId)+1,end=start+s.oldPageIds.length;
  if(start<0||end>original.length||JSON.stringify(original.slice(start,end).map(p=>p.id))!==JSON.stringify(s.oldPageIds)||(original[start-1]?.id??null)!==s.beforePageId||(original[end]?.id??null)!==s.afterPageId)throw Error('ページの前後境界が変わりました');
  for(const p of original.slice(start,end)){
   inside.add(p.id);
   if((p.manual||p.elements?.length)&&!s.replacementPages.some(n=>JSON.stringify(n)===JSON.stringify(p)))throw Error('独立した手動要素があるページは削除できません');
  }
  return {start,end,splice:s};
 }).sort((a,b)=>a.start-b.start||a.end-b.end);
 for(let i=1;i<ranges.length;i++){const a=ranges[i-1],b=ranges[i];if(b.start<a.end||b.start===a.start||a.start===a.end&&b.start===a.end||b.start===b.end&&b.start===a.end)throw Error('ページ置換区間が重複しています');}
 const layout=structuredClone(project.layout);
 for(const {start,end,splice} of [...ranges].reverse())layout.pages.splice(start,end-start,...structuredClone(splice.replacementPages));
 const nextIds=new Set(changedPanels.map(p=>p.id)),oldIds=new Set(project.panels.map(p=>p.id));
 for(const page of original.filter(p=>!inside.has(p.id)))for(const slot of page.slots){if(!slot.panelId)continue;const old=project.panels.find(p=>p.id===slot.panelId),next=changedPanels.find(p=>p.id===slot.panelId);if(JSON.stringify(old)!==JSON.stringify(next))throw Error('対象外のコマ・原文・作画は変更できません');}
 for(const panel of project.panels)if(!nextIds.has(panel.id)&&panel.manual)throw Error('手動コマは自動削除できません');
 for(const binding of project.panelMotions??[]){const old=project.panels.find(p=>p.id===binding.panelId),next=changedPanels.find(p=>p.id===binding.panelId);if(old&&(!next||old.image!==next.image||old.artwork_revision!==next.artwork_revision||JSON.stringify([old.sourceRefs,old.snapshotId,old.unitIds])!==JSON.stringify([next.sourceRefs,next.snapshotId,next.unitIds])))throw Error('動画の開始画像・原稿対応が変わります。動画割当を含む更新案を確認してください');}
 layout.knownPanelIds=changedPanels.map(p=>p.id);
 if(layout.imageCrops)for(const id of Object.keys(layout.imageCrops))if(!nextIds.has(id))delete layout.imageCrops[id];
 validateLayout(layout,changedPanels);
 const before=original.flatMap(assignedIds),after=layout.pages.flatMap(assignedIds);
 const required=changedPanels.filter(p=>before.includes(p.id)||!oldIds.has(p.id)).map(p=>p.id);
 if(required.some(id=>!after.includes(id))) {const error=Error('残すコマを配置できません。隣接ページを含む範囲へ広げてください');error.code='LAYOUT_SCOPE_EXPANSION_REQUIRED';error.panelIds=required.filter(id=>!after.includes(id));throw error;}
 if(JSON.stringify(changedPanels.filter(p=>after.includes(p.id)).map(p=>p.id))!==JSON.stringify(after))throw Error('配置パッチが読書順を変更しています');
 for(const {splice} of ranges)for(const page of splice.replacementPages)for(let i=0;i<page.slots.length;i++)if(page.slots.slice(i+1).some(s=>overlaps(page.slots[i].points,s.points)))throw Error('置換ページのコマ枠が重なっています');
 return layout;
}
export function applyLayoutSplices(project,splices,label='区間のコマ割り変更',baseContentToken=project.contentToken){
 const layout=validateLayoutPatch(project,project.panels,splices,baseContentToken);
 if(JSON.stringify(layout)===JSON.stringify(project.layout))return project;
 return {...project,layout,layoutHistory:[...(project.layoutHistory??[]),{layout:project.layout,label}].slice(-100),layoutRedo:[]};
}
export function reflowLayoutInterval(project,start,count,capacity,opId){
 if(!Number.isInteger(capacity)||capacity<1||capacity>16||typeof opId!=='string'||!opId)throw Error('局所配置の枠数・操作IDが不正です');
 const pages=project.layout.pages.slice(start,start+count),ids=pages.flatMap(assignedIds),replacement=[];
 for(let at=0;at<Math.max(1,ids.length);at+=capacity){const index=replacement.length,old=pages[index],slots=template(at>0?Math.min(capacity,ids.length-at):capacity,ids.slice(at,at+capacity)).map((slot,i)=>({...slot,id:`layout:${opId}:slot:${index}:${i}`}));replacement.push({id:old?.id??`layout:${opId}:page:${index}`,slots});}
 return layoutSplice(project,start,count,replacement);
}
