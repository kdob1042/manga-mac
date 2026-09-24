import React, {useEffect,useMemo,useRef,useState} from 'react';
import {template,validQuad,changeLayout,undoLayout,layoutWarnings,pagePanels,bounds,PAGE,layoutSplice,applyLayoutSplices,reflowLayoutInterval,artPoints,inside} from './layout.js';
import {defaultCrop,containCrop,coverCrop,cropRect,panCrop} from './image-crop.js';
import { imageOf } from './canvas-image.js';
import { pagePNG } from './render.js';
import {proposeLayout,layoutBase,savedLayoutCandidates,adoptSavedLayoutCandidate,discardLayoutCandidate} from './layout-ai.js';
import {askLLM} from './llm';
import {localNameEditReady,requireLocalNameEdit} from './name-v2-ai.js';
export default function LayoutEditor({project,current,commit,run,busy,pageIndex,setPage,model,selected,cancelled,onSelect,active:visible=true}) {
  const [draft,setDraft]=useState(null),[active,setActive]=useState(null),[preview,setPreview]=useState(null),[previewError,setPreviewError]=useState(''),[count,setCount]=useState(6),[instruction,setInstruction]=useState(''),[candidateSelection,setCandidateSelection]=useState(null),[candidatePreview,setCandidatePreview]=useState(null),[zoom,setZoom]=useState(100),[whole,setWhole]=useState(false);
  const [candidateError,setCandidateError]=useState(''),[previewPageOffset,setPreviewPageOffset]=useState(null);
  const [rangeCount,setRangeCount]=useState(1);
  const rangeLength=Math.min(rangeCount,Math.max(1,project.layout.pages.length-pageIndex));
  const svg=useRef(),gesture=useRef(null),draftRef=useRef(null),proposalDetails=useRef(null);
  const [imageMode,setImageMode]=useState(false),[dimensions,setDimensions]=useState({});
  const layout=draft??project.layout,page=layout?.pages[pageIndex];
  const localNameMode=project.namePlan?.format==='manga-mac/name-plan/v2'&&project.namePlan?.status==='adopted';
  const nameEditReady=localNameMode&&localNameEditReady(model);
  const candidates=useMemo(()=>savedLayoutCandidates(project),[project.jobs]);
  const candidate=candidateSelection?.pageId===page?.id
    ? candidates.find(value=>value.jobId===candidateSelection.jobId)??null
    : candidates.findLast(value=>value.scope.includes(page?.id))??null;
  const base=useMemo(()=>layoutBase(project),[project.layout,project.active,project.panels]);
  const range=candidate?.range;
  const previewing=!!range&&!candidate.invalidReason&&candidate.base===base;
  const candidateOffset=previewing?Math.max(0,Math.min(range.count-1,previewPageOffset??pageIndex-range.first)):0;
  const canvasPage=previewing?range.pages[candidateOffset]:page;
  const candidateImage=previewing&&candidatePreview?.jobId===candidate.jobId&&candidatePreview.base===base?candidatePreview.images[candidateOffset]:null;
  useEffect(()=>{
    setCandidateError('');
    if(!visible||!previewing)return;
    setCandidatePreview(null);
    let stopped=false;
    (async()=>{
      const images=[];
      for(const target of candidate.range.pages){
        if(stopped)return;
        images.push(await pagePNG(pagePanels(project,target),project.snapshots,project.localizations,project.output_locale,target,true,candidate.layout.imageCrops));
      }
      if(!stopped)setCandidatePreview({jobId:candidate.jobId,base,images});
    })().catch(error=>{if(!stopped){setCandidatePreview(null);setCandidateError(error.message);}});
    return()=>{stopped=true;};
  },[visible,candidate?.jobId,base,previewing,project.snapshots,project.localizations,project.output_locale]);
  useEffect(()=>{setDraft(null);draftRef.current=null;setActive(null);gesture.current=null;setPreviewPageOffset(null);},[pageIndex,project.layout]);
  useEffect(()=>{setDraft(null);draftRef.current=null;setActive(null);gesture.current=null;setPreviewPageOffset(null);setImageMode(false);if(candidate?.jobId)setZoom(100);},[candidate?.jobId]);
  useEffect(()=>{
    if(!visible)return;
    let stopped=false;setPreviewError('');
    if(page)pagePNG(pagePanels(project,page),project.snapshots,project.localizations,project.output_locale,page,true,layout.imageCrops).then(src=>{if(!stopped)setPreview(src);}).catch(e=>{if(!stopped){setPreview(null);setPreviewError(e.message);}});
    return()=>{stopped=true;};
  },[visible,page,project,layout.imageCrops]);
  useEffect(()=>{if(!visible)return;let stopped=false;Promise.all(pagePanels(project,page).filter(p=>p.image).map(async p=>{const im=await imageOf(p.image);return [p.id,[im.width,im.height]];})).then(entries=>{if(!stopped)setDimensions(Object.fromEntries(entries));}).catch(()=>{});return()=>{stopped=true;};},[visible,page,project.panels]);
  function cancelDrag(){gesture.current=null;draftRef.current=null;setDraft(null);}
  useEffect(()=>{const key=e=>{if(e.key==='Escape')cancelDrag();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  function position(e){const r=svg.current.getBoundingClientRect();return [(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height];}
  function clampDelta(points,dx,dy){
    dx=Math.max(-Math.min(...points.map(p=>p[0])),Math.min(1-Math.max(...points.map(p=>p[0])),dx));
    dy=Math.max(-Math.min(...points.map(p=>p[1])),Math.min(1-Math.max(...points.map(p=>p[1])),dy));
    return [dx,dy];
  }
  function containsHome(home,overflow){return home.every(p=>inside(p,overflow));}
  function start(e,slot,{vertex=null,overflow=false}={}){if(busy||previewing||e.button!==0)return;e.preventDefault();e.stopPropagation();setActive(slot.id);onSelect?.(slot.panelId);
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
    const frozen=structuredClone(current.current),base=layoutBase(frozen);
    if(localNameMode)requireLocalNameEdit(model);
    const scope=localNameMode?[frozen.layout.pages[pageIndex]?.id].filter(Boolean):(whole?frozen.layout.pages.map(p=>p.id):frozen.layout.pages.slice(pageIndex,pageIndex+rangeLength).map(p=>p.id));
    if(frozen.jobs.filter(j=>j.kind==='layout'&&j.input_hash===base).length>=3)throw Error('この基準版での提案は3回までです。候補を確認するか手動編集してください');
    const job={id:crypto.randomUUID(),kind:'layout',scope:{type:'pageLayout',ids:scope},input_hash:base,status:'running',source_revision:frozen.active,base_revision:frozen.revision,attempts:1,at:new Date().toISOString()};
    await commit({...current.current,jobs:[...current.current.jobs,job]});
    try {
      const microEditPrefix=localNameMode?'確定済みネームの現在ページだけを微修正する。ページ数、コマID、読書順、本文、画像、対象外ページを変更しない。指示にない改善を加えない。\n':'';
      const proposal=await proposeLayout(frozen,scope,`${microEditPrefix}${instruction}\n選択コマ: ${slot?.panelId??selected??'なし'}`, (prompt,schema)=>askLLM(model,{prompt,schema,purpose:'layout'}));
      if(localNameMode&&proposal.replacementCount!==1)throw Error('局所修正ではページ数を変更できません');
      if(cancelled?.())throw Error('コマ割りの提案を停止しました');
      const previews=[];
      for(const target of proposal.layout.pages.slice(frozen.layout.pages.findIndex(p=>p.id===scope[0]),frozen.layout.pages.findIndex(p=>p.id===scope[0])+proposal.replacementCount))previews.push(await pagePNG(pagePanels(frozen,target),frozen.snapshots,frozen.localizations,frozen.output_locale,target,true,proposal.layout.imageCrops));
      const result={...proposal,jobId:job.id};
      await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'candidate',layout_candidate:result}:j)});
      setCandidateSelection({pageId:page?.id,jobId:job.id});setPreviewPageOffset(0);setCandidatePreview({jobId:job.id,base:proposal.base,images:previews});
      if(proposalDetails.current)proposalDetails.current.open=false;
    } catch(e) {await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'failed'}:j)});throw e;}
  }
  return <section className="layout-editor" aria-label="コマ割り編集">
    <div className="toolbar"><strong>コマ割り編集</strong><button disabled={busy||previewing||!project.layoutHistory?.length} onClick={()=>run('枠を戻す',()=>commit(undoLayout(current.current)))}>枠をUndo</button><button disabled={busy||previewing||!project.layoutRedo?.length} onClick={()=>run('枠をやり直す',()=>commit(undoLayout(current.current,true)))}>枠をRedo</button><button disabled={busy||previewing} onClick={()=>run('ページ追加',async()=>{const p=current.current,at=p.layout.pages.length?pageIndex+1:0;await commitSplices(p,[layoutSplice(p,at,0,[{id:crypto.randomUUID(),slots:template(count)}])],'ページ追加');setPage(at);})}>ページ追加</button><button disabled={busy||previewing||!page} onClick={()=>run('ページ削除',async()=>{const p=current.current;await commitSplices(p,[layoutSplice(p,pageIndex,1,[])],'ページ削除');setPage(Math.max(0,pageIndex-1));})}>このページを外す</button></div>
    {!previewing&&<p>コマを選び、四隅をドラッグして変形。枠内をドラッグすると全体を移動します。Escで取消。絵や本文は変更しません。枠破りでは、従来のコマ割りを描いたうえに、ホーム枠の外へ出る作画だけが隣の上に乗ります。破線ははみ出し範囲です。</p>}
    <details ref={proposalDetails}><summary>{localNameMode?'ローカルAIでこのページを修正':'演出AIでこのページを配置'}</summary><p>{localNameMode?'取り込んだネームと現在のページを基準に、表示ページだけの配置案を作ります。採用するまで現在の配置は変わりません。':'提案が返ると、このキャンバスを仮の配置に切り替えます。採用するまで作品の配置は変わりません。'}</p>{!localNameMode&&<label><input type="checkbox" checked={whole} onChange={e=>setWhole(e.target.checked)}/>全ページを対象（ページ分割・6コマ配置も変更）</label>}<textarea aria-label="コマ割りの指示" value={instruction} onChange={e=>setInstruction(e.target.value)} placeholder={localNameMode?'3コマ目を大きく／このページだけ再配置':'最初のコマを横長の大ゴマに。最後の境界を斜めに'}/><button disabled={busy||!page||!model.connectionId||(localNameMode&&!nameEditReady)} onClick={()=>run(localNameMode?'ローカルAIで配置修正を提案中':'AIコマ割りを提案中',propose)}>{localNameMode?'修正案を作る':'コマ割りを提案'}</button>{localNameMode&&!nameEditReady?<small>確定ネームの局所AI修正はOllama（ローカル）専用です。手動ドラッグ編集はそのまま使えます。</small>:!model.connectionId&&<small>接続・人物設定でAIを登録してください。Ollama／クラウド共通です。</small>}</details>
    {candidates.length>0&&!previewing&&<label>保存したコマ割り候補<select aria-label="保存したコマ割り候補" disabled={busy} value={candidate?.jobId??''} onChange={event=>{setCandidateSelection({pageId:page?.id,jobId:event.target.value||null});setPreviewPageOffset(null);setCandidateError('');}}><option value="">採用済みの配置を表示</option>{candidates.map(value=><option key={value.jobId} value={value.jobId}>{value.range?.label??'対象不明'} · {value.reason}{value.invalidReason?'（確認不可）':value.base!==base?'（旧版）':''}</option>)}</select></label>}
    {candidate&&<div className={`layout-candidate ${previewing?'is-preview':''}`} role="status">
      <div className="candidate-decision"><strong>{previewing?`AI案を確認中${range?` · ${range.label}`:''}`:'保存したAI案'}</strong>
        {previewing&&!candidateImage&&!candidateError&&<span>ページを描画中…</span>}
        {(candidate.invalidReason||candidateError)&&<span role="alert">{candidate.invalidReason??candidateError}</span>}
        {!candidate.invalidReason&&candidate.base!==base&&<span>作品が変更されたため、この案は採用できません。</span>}
        <div className="toolbar">{previewing&&<button className="primary" disabled={busy||!candidateImage||!!candidateError} onClick={()=>run('AI案を採用',async()=>{const at=range.first,next=adoptSavedLayoutCandidate(current.current,candidate.jobId);await commit(next);setCandidateSelection({pageId:next.layout.pages[at]?.id,jobId:null});setCandidatePreview(null);onSelect?.(null);setPage(at);})}>採用して編集</button>}<button disabled={busy} onClick={()=>run('AI案を採用せず編集',async()=>{await commit(discardLayoutCandidate(current.current,candidate.jobId));setCandidateSelection({pageId:page?.id,jobId:null});setCandidatePreview(null);setCandidateError('');})}>採用せず編集</button></div>
      </div>
      {previewing&&range.count>1&&<div className="candidate-pager"><button aria-label="候補の前ページ" disabled={busy||candidateOffset===0} onClick={()=>setPreviewPageOffset(candidateOffset-1)}>‹</button><span>候補 {candidateOffset+1} / {range.count} ページ</span><button aria-label="候補の次ページ" disabled={busy||candidateOffset===range.count-1} onClick={()=>setPreviewPageOffset(candidateOffset+1)}>›</button></div>}
    </div>}
    {!previewing&&<div className="toolbar"><button aria-pressed={!imageMode} disabled={busy} onClick={()=>{cancelDrag();setImageMode(false);}}>枠を編集</button><button aria-pressed={imageMode} disabled={busy} onClick={()=>{cancelDrag();setImageMode(true);}}>画像トリミング</button></div>}
    {imageMode && !previewing && <div className="crop-controls"><p>既定はコマ形状でマスクした全面表示です。枠を選ぶと画像をドラッグできます。元画像・セリフ・吹き出しは変更しません。確定した枠と同じ配置で表示します。</p>
      {slot?.panelId && <><button disabled={busy||previewing||!dimensions[slot.panelId]} onClick={()=>setCrop(defaultCrop())}>画像を中央・等倍に戻す</button>
      {crop && <label>画像の拡大率<select aria-label="画像の拡大率" disabled={busy||previewing} value={crop.zoom} onChange={e=>setCrop({zoom:Number(e.target.value),x:crop.x,y:crop.y})}>{[1,1.25,1.5,2,3,4,6,8].map(n=><option key={n} value={n}>{n}倍</option>)}</select></label>}
      <button disabled={busy||previewing||!dimensions[slot.panelId]} onClick={()=>setCrop(crop?containCrop():defaultCrop())}>{crop?'画像全体を枠内に収める':'このコマを全面表示にする'}</button></>}
    </div>}
    {!previewing&&<><div className="toolbar"><label>対象ページ数<input aria-label="対象ページ数" type="number" min="1" max={Math.max(1,project.layout.pages.length-pageIndex)} value={rangeLength} onChange={e=>setRangeCount(Math.max(1,Math.floor(Number(e.target.value)||1)))}/></label><label>枠数<select aria-label="枠数" value={count} onChange={e=>setCount(Number(e.target.value))}>{Array.from({length:16},(_,i)=><option key={i} value={i+1}>{i+1}コマ</option>)}</select></label><button disabled={busy||!page} onClick={()=>run('このページを詰め直す',()=>{const p=current.current;return commitSplices(p,[reflowLayoutInterval(p,pageIndex,rangeLength,count,crypto.randomUUID())],'このページを詰め直す');})}>テンプレートを適用</button><label>表示倍率<input aria-label="表示倍率" type="range" min="50" max="160" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/>{zoom}%</label></div><small>テンプレートはこのページから選択した区間のコマだけを詰め直します。入りきらない場合は直後にページを追加し、前後の既存ページは保持します。枠の追加では本文を分割しません。読書順は枠番号順です。</small></>}
    {warnings.length>0&&<div className="message error" role="status">{warnings.map((w,i)=><div key={i}>{w}</div>)}</div>}
    {previewError&&<div role="alert" className="message error">{previewError}</div>}
    {canvasPage&&<div className="layout-scroll"><svg ref={svg} className="layout-canvas" role={previewing?'img':undefined} aria-label={previewing?'AIコマ割り候補（未採用）':'採用済みのコマ割り'} viewBox="0 0 1600 2260" style={{width:`${zoom}%`}} onPointerMove={move} onPointerUp={end} onPointerCancel={cancelDrag} onLostPointerCapture={()=>{if(gesture.current)cancelDrag();}}>
      <rect width="1600" height="2260" fill="white"/>{previewing?(candidateImage&&<image href={candidateImage} width="1600" height="2260"/>):(preview&&<image href={preview} width="1600" height="2260"/>)}
      {canvasPage.slots.map((s,i)=>s.overflow&&<polygon key={`overflow-${s.id}`} data-testid={`overflow-slot-${i}`} points={s.overflow.points.map(([x,y])=>`${x*1600},${y*2260}`).join(' ')} fill="transparent" stroke="#2a6fdb" strokeWidth="4" strokeDasharray="12 8" onPointerDown={e=>!imageMode&&start(e,s,{overflow:true})}/>)}
      {canvasPage.slots.map((s,i)=><g key={s.id}><polygon data-testid={`layout-slot-${i}`} points={s.points.map(([x,y])=>`${x*1600},${y*2260}`).join(' ')} fill="transparent" stroke={active===s.id?'#e96e40':'#555'} strokeWidth="5" onPointerDown={e=>start(e,s)}/><text x={s.points[0][0]*1600+12} y={s.points[0][1]*2260+35} pointerEvents="none" fill="#b34f29" fontSize="28">{i+1}</text>{!previewing&&!imageMode&&active===s.id&&s.points.map(([x,y],j)=><circle data-testid={`vertex-${j}`} key={j} cx={x*1600} cy={y*2260} r="19" fill="#fff" stroke="#e96e40" strokeWidth="7" onPointerDown={e=>start(e,s,{vertex:j})}/>)}{!previewing&&!imageMode&&active===s.id&&s.overflow?.points.map(([x,y],j)=><circle data-testid={`overflow-vertex-${j}`} key={`o${j}`} cx={x*1600} cy={y*2260} r="19" fill="#fff" stroke="#2a6fdb" strokeWidth="7" onPointerDown={e=>start(e,s,{vertex:j,overflow:true})}/>)}</g>)}
    </svg></div>}
    {slot&&!previewing&&<label>選択枠のコマ<select aria-label="選択枠のコマ" disabled={busy} value={slot.panelId??''} onChange={e=>update(l=>{const value=e.target.value||null; l.pages.forEach(p=>p.slots.forEach(s=>{if(value&&s.panelId===value)s.panelId=null;}));l.pages[pageIndex].slots.find(s=>s.id===slot.id).panelId=value;},'コマ割当を移動',{pageIds:project.layout.pages.filter(p=>p.id===page.id||p.slots.some(s=>s.panelId===e.target.value)).map(p=>p.id)})}><option value="">未割当</option>{project.panels.map(p=><option key={p.id} value={p.id}>{p.id}</option>)}</select><small>既存コマを選ぶと元の枠から移動します。絵や原文は保持します。</small></label>}
    {slot&&!previewing&&!imageMode&&<div className="toolbar"><button aria-pressed={!!slot.overflow} disabled={busy} onClick={()=>update(l=>{const s=l.pages[pageIndex].slots.find(s=>s.id===slot.id);if(s.overflow)delete s.overflow;else s.overflow={points:structuredClone(s.points)};},slot.overflow?'枠破りを解除':'枠破り')}>枠破り</button>{slot.overflow&&<label>重ね順<input aria-label="重ね順" type="number" min="0" max="15" disabled={busy} value={slot.overflow.z??0} onChange={e=>update(l=>{const s=l.pages[pageIndex].slots.find(s=>s.id===slot.id);if(!s.overflow)return;s.overflow={...s.overflow,z:Math.max(0,Math.min(15,Math.floor(Number(e.target.value)||0)))};},'はみ出しの重ね順')}/></label>}</div>}
  </section>;
}
