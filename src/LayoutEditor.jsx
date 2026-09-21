import React, {useEffect,useRef,useState} from 'react';
import {template,validQuad,changeLayout,undoLayout,layoutWarnings,pagePanels,bounds,PAGE,layoutSplice,applyLayoutSplices,reflowLayoutInterval,artPoints,inside} from './layout.js';
import {defaultCrop,containCrop,coverCrop,cropRect,panCrop} from './image-crop.js';
import { imageOf } from './canvas-image.js';
import { pagePNG } from './render.js';
import {proposeLayout,adoptLayoutProposal,layoutBase} from './layout-ai.js';
import {askLLM} from './llm';
export default function LayoutEditor({project,current,commit,run,busy,pageIndex,setPage,model,selected,cancelled,onSelect}) {
  const [draft,setDraft]=useState(null),[active,setActive]=useState(null),[preview,setPreview]=useState(null),[previewError,setPreviewError]=useState(''),[count,setCount]=useState(6),[instruction,setInstruction]=useState(''),[candidate,setCandidate]=useState(null),[candidatePreview,setCandidatePreview]=useState(null),[zoom,setZoom]=useState(100),[whole,setWhole]=useState(false);
  const [rangeCount,setRangeCount]=useState(1);
  const rangeLength=Math.min(rangeCount,Math.max(1,project.layout.pages.length-pageIndex));
  const svg=useRef(),gesture=useRef(null),draftRef=useRef(null);
  const [imageMode,setImageMode]=useState(false),[dimensions,setDimensions]=useState({});
  const layout=draft??project.layout,page=layout?.pages[pageIndex];
  useEffect(()=>{setDraft(null);draftRef.current=null;setActive(null);gesture.current=null;},[pageIndex,project.layout]);
  useEffect(()=>{
    let stopped=false;setPreviewError('');
    if(page)pagePNG(pagePanels(project,page),project.snapshots,project.localizations,project.output_locale,page,true,layout.imageCrops).then(src=>{if(!stopped)setPreview(src);}).catch(e=>{if(!stopped){setPreview(null);setPreviewError(e.message);}});
    return()=>{stopped=true;};
  },[page,project,layout.imageCrops]);
  useEffect(()=>{let stopped=false;Promise.all(project.panels.filter(p=>p.image).map(async p=>{const im=await imageOf(p.image);return [p.id,[im.width,im.height]];})).then(entries=>{if(!stopped)setDimensions(Object.fromEntries(entries));}).catch(()=>{});return()=>{stopped=true;};},[project.panels]);
  function cancelDrag(){gesture.current=null;draftRef.current=null;setDraft(null);}
  useEffect(()=>{const key=e=>{if(e.key==='Escape')cancelDrag();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  function position(e){const r=svg.current.getBoundingClientRect();return [(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height];}
  function clampDelta(points,dx,dy){
    dx=Math.max(-Math.min(...points.map(p=>p[0])),Math.min(1-Math.max(...points.map(p=>p[0])),dx));
    dy=Math.max(-Math.min(...points.map(p=>p[1])),Math.min(1-Math.max(...points.map(p=>p[1])),dy));
    return [dx,dy];
  }
  function containsHome(home,overflow){return home.every(p=>inside(p,overflow));}
  function start(e,slot,{vertex=null,overflow=false}={}){if(busy||e.button!==0)return;e.preventDefault();e.stopPropagation();setActive(slot.id);onSelect?.(slot.panelId);
    if(imageMode && (!slot.panelId || !dimensions[slot.panelId]))return;
    gesture.current={pointer:e.pointerId,start:position(e),slot:structuredClone(slot),vertex,overflow,base:project.layout,imageMode};e.currentTarget.setPointerCapture(e.pointerId);}
  function move(e){const g=gesture.current;if(!g||g.pointer!==e.pointerId)return;const at=position(e);
    if(g.imageMode){const points=artPoints(g.slot),b=bounds(points),box={x:b.x*PAGE.width,y:b.y*PAGE.height,width:b.width*PAGE.width,height:b.height*PAGE.height},crop=coverCrop(g.base.imageCrops?.[g.slot.panelId]);
      if(!crop)return;
      const r=cropRect(...dimensions[g.slot.panelId],box,crop),next=structuredClone(g.base);
      next.imageCrops??={};next.imageCrops[g.slot.panelId]=panCrop(crop,r,box,(at[0]-g.start[0])*PAGE.width,(at[1]-g.start[1])*PAGE.height);
      draftRef.current=next;setDraft(next);return;}
    const next=structuredClone(g.base),target=next.pages[pageIndex].slots.find(s=>s.id===g.slot.id);
    if(g.overflow){
      const overflow=g.slot.overflow.points.map(p=>[...p]),home=g.slot.points;
      if(g.vertex!==null)overflow[g.vertex]=at.map(v=>Math.max(0,Math.min(1,v)));
      else {const [dx,dy]=clampDelta(overflow,at[0]-g.start[0],at[1]-g.start[1]);overflow.forEach(p=>{p[0]+=dx;p[1]+=dy;});}
      if(!validQuad(overflow)||!containsHome(home,overflow))return;
      target.overflow={...g.slot.overflow,points:overflow};
    } else {
      const points=g.slot.points.map(p=>[...p]);
      let overflow=g.slot.overflow?.points.map(p=>[...p]);
      if(g.vertex!==null){points[g.vertex]=at.map(v=>Math.max(0,Math.min(1,v)));}
      else {const together=overflow?[...points,...overflow]:points;const [dx,dy]=clampDelta(together,at[0]-g.start[0],at[1]-g.start[1]);points.forEach(p=>{p[0]+=dx;p[1]+=dy;});overflow?.forEach(p=>{p[0]+=dx;p[1]+=dy;});}
      if(!validQuad(points)||(overflow&&(!validQuad(overflow)||!containsHome(points,overflow))))return;
      target.points=points;if(overflow)target.overflow={...g.slot.overflow,points:overflow};
    }
    draftRef.current=next;setDraft(next);
  }
  function end(e){if(!gesture.current||gesture.current.pointer!==e.pointerId)return;const next=draftRef.current;gesture.current=null;draftRef.current=null;setDraft(null);if(next)run('コマ割りを保存',()=>commit(changeLayout(current.current,next,'コマ割りを保存',{pageIds:[page.id]})));}
  function update(fn,label='コマ割りを保存',scope={pageIds:page?[page.id]:[]}){run(label,async()=>{const next=structuredClone(current.current.layout);fn(next);await commit(changeLayout(current.current,next,label,scope));});}
  async function commitSplices(p,splices,label){
    const next=applyLayoutSplices(p,splices,label);
    for(const page of splices.flatMap(s=>s.replacementPages))await pagePNG(pagePanels(next,page),next.snapshots,next.localizations,next.output_locale,page,true,next.layout.imageCrops);
    return commit(next);
  }
  const warnings=layout?layoutWarnings(layout,project.panels):[];
  const slot=page?.slots.find(s=>s.id===active);
  const stored=slot && layout.imageCrops?.[slot.panelId];
  const crop=coverCrop(stored);
  function setCrop(value){update(l=>{l.imageCrops??={};if(value)l.imageCrops[slot.panelId]=value;else delete l.imageCrops[slot.panelId];},'画像配置を保存');}
  async function propose(){
    const frozen=structuredClone(current.current),base=layoutBase(frozen),scope=whole?frozen.layout.pages.map(p=>p.id):frozen.layout.pages.slice(pageIndex,pageIndex+rangeLength).map(p=>p.id);
    if(frozen.jobs.filter(j=>j.kind==='layout'&&j.input_hash===base).length>=3)throw Error('この基準版での提案は3回までです。候補を確認するか手動編集してください');
    const job={id:crypto.randomUUID(),kind:'layout',scope:{type:'pageLayout',ids:scope},input_hash:base,status:'running',source_revision:frozen.active,base_revision:frozen.revision,attempts:1,at:new Date().toISOString()};
    await commit({...current.current,jobs:[...current.current.jobs,job]});
    try {
      const proposal=await proposeLayout(frozen,scope,`${instruction}\n選択コマ: ${slot?.panelId??selected??'なし'}`, (prompt,schema)=>askLLM(model,{prompt,schema,purpose:'layout'}));
      if(cancelled?.())throw Error('コマ割りの提案を停止しました');
      const previews=[];
      for(const target of proposal.layout.pages.slice(frozen.layout.pages.findIndex(p=>p.id===scope[0]),frozen.layout.pages.findIndex(p=>p.id===scope[0])+proposal.replacementCount))previews.push(await pagePNG(pagePanels(frozen,target),frozen.snapshots,frozen.localizations,frozen.output_locale,target,true,proposal.layout.imageCrops));
      const result={...proposal,jobId:job.id};
      await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'candidate',layout_candidate:result}:j)});
      setCandidate(result);setCandidatePreview(previews);
    } catch(e) {await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'failed'}:j)});throw e;}
  }
  return <section className="layout-editor" aria-label="コマ割り編集">
    <div className="toolbar"><strong>コマ割り編集</strong><button disabled={busy||!project.layoutHistory?.length} onClick={()=>run('枠を戻す',()=>commit(undoLayout(current.current)))}>枠をUndo</button><button disabled={busy||!project.layoutRedo?.length} onClick={()=>run('枠をやり直す',()=>commit(undoLayout(current.current,true)))}>枠をRedo</button><button disabled={busy} onClick={()=>run('ページ追加',async()=>{const p=current.current,at=p.layout.pages.length?pageIndex+1:0;await commitSplices(p,[layoutSplice(p,at,0,[{id:crypto.randomUUID(),slots:template(count)}])],'ページ追加');setPage(at);})}>ページ追加</button><button disabled={busy||!page} onClick={()=>run('ページ削除',async()=>{const p=current.current;await commitSplices(p,[layoutSplice(p,pageIndex,1,[])],'ページ削除');setPage(Math.max(0,pageIndex-1));})}>このページを外す</button></div>
    <p>コマを選び、四隅をドラッグして変形。枠内をドラッグすると全体を移動します。Escで取消。絵や本文は変更しません。枠破りでは、従来のコマ割りを描いたうえに、ホーム枠の外へ出る作画だけが隣の上に乗ります。破線ははみ出し範囲です。</p>
    <div className="toolbar"><button aria-pressed={!imageMode} disabled={busy} onClick={()=>{cancelDrag();setImageMode(false);}}>枠を編集</button><button aria-pressed={imageMode} disabled={busy} onClick={()=>{cancelDrag();setImageMode(true);}}>画像トリミング</button></div>
    {imageMode && <div className="crop-controls"><p>既定はコマ形状でマスクした全面表示です。枠を選ぶと画像をドラッグできます。元画像・セリフ・吹き出しは変更しません。確定した枠と同じ配置で表示します。</p>
      {slot?.panelId && <><button disabled={busy||!dimensions[slot.panelId]} onClick={()=>setCrop(defaultCrop())}>画像を中央・等倍に戻す</button>
      {crop && <label>画像の拡大率<select aria-label="画像の拡大率" disabled={busy} value={crop.zoom} onChange={e=>setCrop({zoom:Number(e.target.value),x:crop.x,y:crop.y})}>{[1,1.25,1.5,2,3,4,6,8].map(n=><option key={n} value={n}>{n}倍</option>)}</select></label>}
      <button disabled={busy||!dimensions[slot.panelId]} onClick={()=>setCrop(crop?containCrop():defaultCrop())}>{crop?'画像全体を枠内に収める':'このコマを全面表示にする'}</button></>}
    </div>}
    <div className="toolbar"><label>対象ページ数<input aria-label="対象ページ数" type="number" min="1" max={Math.max(1,project.layout.pages.length-pageIndex)} value={rangeLength} onChange={e=>setRangeCount(Math.max(1,Math.floor(Number(e.target.value)||1)))}/></label><label>枠数<select aria-label="枠数" value={count} onChange={e=>setCount(Number(e.target.value))}>{Array.from({length:16},(_,i)=><option key={i} value={i+1}>{i+1}コマ</option>)}</select></label><button disabled={busy||!page} onClick={()=>run('このページを詰め直す',()=>{const p=current.current;return commitSplices(p,[reflowLayoutInterval(p,pageIndex,rangeLength,count,crypto.randomUUID())],'このページを詰め直す');})}>テンプレートを適用</button><label>表示倍率<input aria-label="表示倍率" type="range" min="50" max="160" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/>{zoom}%</label></div>
    <small>テンプレートはこのページから選択した区間のコマだけを詰め直します。入りきらない場合は直後にページを追加し、前後の既存ページは保持します。枠の追加では本文を分割しません。読書順は枠番号順です。</small>
    {warnings.length>0&&<div className="message error" role="status">{warnings.map((w,i)=><div key={i}>{w}</div>)}</div>}
    {previewError&&<div role="alert" className="message error">{previewError}</div>}
    {page&&<div className="layout-scroll"><svg ref={svg} className="layout-canvas" viewBox="0 0 1600 2260" style={{width:`${zoom}%`}} onPointerMove={move} onPointerUp={end} onPointerCancel={cancelDrag} onLostPointerCapture={()=>{if(gesture.current)cancelDrag();}}>
      <rect width="1600" height="2260" fill="white"/>{preview&&<image href={preview} width="1600" height="2260"/>}
      {page.slots.map((s,i)=>s.overflow&&<polygon key={`overflow-${s.id}`} data-testid={`overflow-slot-${i}`} points={s.overflow.points.map(([x,y])=>`${x*1600},${y*2260}`).join(' ')} fill="transparent" stroke="#2a6fdb" strokeWidth="4" strokeDasharray="12 8" onPointerDown={e=>!imageMode&&start(e,s,{overflow:true})}/>)}
      {page.slots.map((s,i)=><g key={s.id}><polygon data-testid={`layout-slot-${i}`} points={s.points.map(([x,y])=>`${x*1600},${y*2260}`).join(' ')} fill="transparent" stroke={active===s.id?'#e96e40':'#555'} strokeWidth="5" onPointerDown={e=>start(e,s)}/><text x={s.points[0][0]*1600+12} y={s.points[0][1]*2260+35} pointerEvents="none" fill="#b34f29" fontSize="28">{i+1}</text>{!imageMode&&active===s.id&&s.points.map(([x,y],j)=><circle data-testid={`vertex-${j}`} key={j} cx={x*1600} cy={y*2260} r="19" fill="#fff" stroke="#e96e40" strokeWidth="7" onPointerDown={e=>start(e,s,{vertex:j})}/>)}{!imageMode&&active===s.id&&s.overflow?.points.map(([x,y],j)=><circle data-testid={`overflow-vertex-${j}`} key={`o${j}`} cx={x*1600} cy={y*2260} r="19" fill="#fff" stroke="#2a6fdb" strokeWidth="7" onPointerDown={e=>start(e,s,{vertex:j,overflow:true})}/>)}</g>)}
    </svg></div>}
    {slot&&<label>選択枠のコマ<select aria-label="選択枠のコマ" disabled={busy} value={slot.panelId??''} onChange={e=>update(l=>{const value=e.target.value||null; l.pages.forEach(p=>p.slots.forEach(s=>{if(value&&s.panelId===value)s.panelId=null;}));l.pages[pageIndex].slots.find(s=>s.id===slot.id).panelId=value;},'コマ割当を移動',{pageIds:project.layout.pages.filter(p=>p.id===page.id||p.slots.some(s=>s.panelId===e.target.value)).map(p=>p.id)})}><option value="">未割当</option>{project.panels.map(p=><option key={p.id} value={p.id}>{p.id}</option>)}</select><small>既存コマを選ぶと元の枠から移動します。絵や原文は保持します。</small></label>}
    {slot&&!imageMode&&<div className="toolbar"><button aria-pressed={!!slot.overflow} disabled={busy} onClick={()=>update(l=>{const s=l.pages[pageIndex].slots.find(s=>s.id===slot.id);if(s.overflow)delete s.overflow;else s.overflow={points:structuredClone(s.points)};},slot.overflow?'枠破りを解除':'枠破り')}>枠破り</button>{slot.overflow&&<label>重ね順<input aria-label="重ね順" type="number" min="0" max="15" disabled={busy} value={slot.overflow.z??0} onChange={e=>update(l=>{const s=l.pages[pageIndex].slots.find(s=>s.id===slot.id);if(!s.overflow)return;s.overflow={...s.overflow,z:Math.max(0,Math.min(15,Math.floor(Number(e.target.value)||0)))};},'はみ出しの重ね順')}/></label>}</div>}
    <details><summary>演出AIでこのページを配置</summary><p>既存コマの割当と形状を提案します。原文の分割や作画は行いません。</p><label><input type="checkbox" checked={whole} onChange={e=>setWhole(e.target.checked)}/>全ページを対象（ページ分割・6コマ配置も変更）</label><textarea aria-label="コマ割りの指示" value={instruction} onChange={e=>setInstruction(e.target.value)} placeholder="最初のコマを横長の大ゴマに。最後の境界を斜めに"/><button disabled={busy||!page||!model.connectionId} onClick={()=>run('AIコマ割りを提案中',propose)}>コマ割りを提案</button>{!model.connectionId&&<small>接続・人物設定で演出AIを登録してください。ローカル／クラウド共通です。</small>}
      {project.jobs.filter(j=>j.kind==='layout'&&j.status==='candidate'&&j.layout_candidate).map(j=><button key={j.id} disabled={busy} onClick={()=>run('保存済み案を表示',async()=>{const c=j.layout_candidate;setCandidate(c);const previews=[];for(const p of c.layout.pages)previews.push(await pagePNG(pagePanels(project,p),project.snapshots,project.localizations,project.output_locale,p,true,c.layout.imageCrops));setCandidatePreview(previews);})}>保存済みのコマ割り案を表示</button>)}
      {candidate&&<div><p>{candidate.reason}</p><p>変更対象: {candidate.scope.length}ページ。本文・作画・人物は保持。</p>{candidatePreview?.map((src,i)=><img key={i} className="page-proof" src={src} alt={`AIコマ割り候補 ${i+1}`}/>)}<button disabled={busy||candidate.base!==layoutBase(project)} onClick={()=>run('AI案を採用',async()=>{const next=adoptLayoutProposal(current.current,candidate);await commit({...next,jobs:next.jobs.map(j=>j.id===candidate.jobId?{...j,status:'complete'}:j)});setCandidate(null);setPage(0);})}>このコマ割りを採用</button><button onClick={()=>setCandidate(null)}>候補を破棄</button>{candidate.base!==layoutBase(project)&&<p>作品が変更されたため、この候補は採用できません。</p>}</div>}
    </details>
  </section>;
}
