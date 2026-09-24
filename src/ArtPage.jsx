import React, {useEffect,useRef,useState} from 'react';
import PageProof from './PageProof.jsx';
import {panelHasText} from './core.js';
import {dragSlotFrame} from './layout.js';

// The page uses the export renderer; region edits still address the original image.
export default function ArtPage({project, page, panels, selected, onSelect, onResize, rect, onRect, busy, sourceText}) {
  const drag = useRef(null);
  const frame = useRef(null),frameDraft=useRef(null),svg=useRef(null);
  const [draft,setDraft]=useState(null);
  const chosen = panels.find(panel => panel.id === selected);
  const displayed=page.slots.map(slot=>draft?.slot.id===slot.id?draft.slot:slot);
  function cancelFrame(){frame.current=null;frameDraft.current=null;setDraft(null);}
  useEffect(()=>{cancelFrame();},[page.id,project.layout]);
  useEffect(()=>{const key=event=>{if(event.key==='Escape')cancelFrame();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  function framePoint(event){
    const box=svg.current.getBoundingClientRect();
    return [(event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height];
  }
  function startFrame(event,slot,{edge=null,vertex=null}={}){
    if(busy||event.button!==0)return;
    event.preventDefault();event.stopPropagation();onSelect(slot.panelId);
    // A missed handle selects the panel; moving it is an explicit modifier.
    if(edge===null&&vertex===null&&!event.altKey)return;
    const box=svg.current.getBoundingClientRect();
    frame.current={pointer:event.pointerId,slot,edge,vertex,start:framePoint(event),width:box.width,height:box.height};
    frameDraft.current=null;
    svg.current.setPointerCapture(event.pointerId);
  }
  function moveFrame(event){
    const gesture=frame.current;if(!gesture||gesture.pointer!==event.pointerId)return;
    const at=framePoint(event),delta=at.map((v,i)=>v-gesture.start[i]);
    if(!frameDraft.current&&Math.hypot(delta[0]*gesture.width,delta[1]*gesture.height)<3)return;
    const next=dragSlotFrame(gesture.slot,gesture,delta,{page,width:gesture.width,height:gesture.height,snap:!event.shiftKey});
    frameDraft.current=next.slot;setDraft(next);
  }
  function endFrame(event){
    if(!frame.current||frame.current.pointer!==event.pointerId)return;
    const gesture=frame.current,slot=frameDraft.current;
    cancelFrame();
    if(slot&&JSON.stringify(slot)!==JSON.stringify(gesture.slot))onResize(gesture.slot.id,slot.points,slot.overflow);
  }
  function point(event) {
    const box = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX-box.left)/box.width)),
      Math.max(0, Math.min(1, (event.clientY-box.top)/box.height))];
  }
  return <section className="art-page-workspace" aria-label="作画ページ">
    <PageProof panels={panels} snapshots={project.snapshots} localizations={project.localizations}
      locale={project.output_locale} page={page} imageCrops={project.layout?.imageCrops} draft hideUnplacedCaptions>
      <svg ref={svg} className="art-page-targets" viewBox="0 0 1600 2260" aria-label="ページのコマを選択・ドラッグで枠を調整" onPointerMove={moveFrame} onPointerUp={endFrame} onPointerCancel={cancelFrame} onLostPointerCapture={()=>{if(frame.current)cancelFrame();}}>
        {displayed.map((shape,index)=>{const slot=page.slots[index],active=selected===slot.panelId;return slot.panelId && <polygon key={slot.id} data-testid={`art-slot-${index}`} points={shape.points.map(([x,y])=>`${x*1600},${y*2260}`).join(' ')}
            role="button" tabIndex={0} aria-label={`${index+1}コマ目を選択`}
            aria-pressed={active} className={active?'selected':''}
            onPointerDown={event=>startFrame(event,slot)}
            onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(slot.panelId);}}}/>;})}
        {draft?.guides.map(({axis,value})=><line key={`${axis}-${value}`} className="frame-snap-guide" x1={axis===0?value*1600:0} y1={axis===1?value*2260:0} x2={axis===0?value*1600:1600} y2={axis===1?value*2260:2260}/>)}
        {displayed.map((shape,index)=>{const slot=page.slots[index];return selected===slot.panelId&&slot.panelId&&<g key={slot.id}>
          {shape.points.map((point,edge)=>{const next=shape.points[(edge+1)%4];return <g key={edge}>
            <line data-testid={`art-edge-${edge}`} className="art-frame-edge" style={{cursor:edge%2?'ew-resize':'ns-resize'}} x1={point[0]*1600} y1={point[1]*2260} x2={next[0]*1600} y2={next[1]*2260} onPointerDown={event=>startFrame(event,slot,{edge})}/>
            <circle className="art-frame-handle" data-testid={`art-handle-${edge}`} cx={(point[0]+next[0])*800} cy={(point[1]+next[1])*1130} r="24" onPointerDown={event=>startFrame(event,slot,{edge})}/>
          </g>;})}
          {shape.points.map((point,vertex)=><circle key={vertex} data-testid={`art-corner-${vertex}`} className="art-frame-corner" cx={point[0]*1600} cy={point[1]*2260} r="24" onPointerDown={event=>startFrame(event,slot,{vertex})}/>)}
        </g>;})}
      </svg>
    </PageProof>
    {panels.some(panel => panel.namePlanVersion !== 2 && panelHasText(panel) && panel.lettering?.mode !== 'balloons' && (!panel.lettering || panel.letteringStatus === 'draft')) &&
      <p className="art-lettering-notice">文字配置待ち：未配置の原稿文は画像に重ねていません。コマを選ぶと原稿を確認できます。</p>}
    {chosen && <p className="art-frame-hint">辺で大きさ、角で形を調整。端に近づけると揃います。移動はOption（Alt）＋ドラッグ、Shiftで端合わせ解除、Escで取消。</p>}
    {chosen && sourceText && <p className="art-panel-source">{sourceText}</p>}
    {chosen?.image && <div className="art-original-edit">
      <p>画像の中身を部分修正する範囲は、この元画像上をドラッグして指定します。</p>
      <div className="art-original-image" onPointerDown={event=>{
        if(busy || event.button!==0)return;
        drag.current=point(event);onRect(null);event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerUp={event=>{
        if(!drag.current)return;
        const start=drag.current,end=point(event);drag.current=null;
        const next=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(end[0]-start[0]),Math.abs(end[1]-start[1])];
        onRect(next[2]>.01&&next[3]>.01?next:null);
      }} onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}>
        <img draggable="false" src={chosen.image} alt="部分修正する元画像"/>
        {rect && <span className="region" style={{left:`${rect[0]*100}%`,top:`${rect[1]*100}%`,width:`${rect[2]*100}%`,height:`${rect[3]*100}%`}}/>}
      </div>
    </div>}
  </section>;
}
