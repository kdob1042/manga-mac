import React, {useRef} from 'react';
import PageProof from './PageProof.jsx';

// The page uses the export renderer; region edits still address the original image.
export default function ArtPage({project, page, panels, selected, onSelect, rect, onRect, busy, sourceText}) {
  const drag = useRef(null);
  const chosen = panels.find(panel => panel.id === selected);
  function point(event) {
    const box = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX-box.left)/box.width)),
      Math.max(0, Math.min(1, (event.clientY-box.top)/box.height))];
  }
  return <section className="art-page-workspace" aria-label="作画ページ">
    <PageProof panels={panels} snapshots={project.snapshots} localizations={project.localizations}
      locale={project.output_locale} page={page} imageCrops={project.layout?.imageCrops} draft>
      <svg className="art-page-targets" viewBox="0 0 1600 2260" aria-label="ページのコマを選択">
        {page.slots.map((slot, index) => slot.panelId && <polygon key={slot.id}
          points={slot.points.map(([x,y])=>`${x*1600},${y*2260}`).join(' ')}
          role="button" tabIndex={0} aria-label={`${index+1}コマ目を選択`}
          aria-pressed={selected===slot.panelId}
          className={selected===slot.panelId?'selected':''}
          onClick={()=>onSelect(slot.panelId)}
          onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(slot.panelId);}}}/>) }
      </svg>
    </PageProof>
    {chosen && sourceText && <p className="art-panel-source">{sourceText}</p>}
    {chosen?.image && <div className="art-original-edit">
      <p>部分修正する場合は元画像上をドラッグして範囲を指定</p>
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
