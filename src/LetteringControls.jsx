import {recognizeRegions} from './visual-regions';
import React, { useState, useRef, useEffect } from 'react';
import { defaultLettering, setLettering, validateLettering } from './lettering';
import { drawLettering, imageOf, pagePNG } from './render';
import { pagePanels } from './layout';
import { containRect } from './image-input';
import { textForPanel } from './localization';
import { proposeLettering } from './lettering-ai';
import { askLLM } from './llm';
import { editBase, executeLocalEdits, editContext } from './edit-commands';
export default function LetteringControls({ panel, current, commit, run, busy, model, pageIndex=0 }) {
  const [layout,setLayout]=useState(()=>structuredClone(panel.lettering??defaultLettering(panel)));
  const [index,setIndex]=useState(0),[problem,setProblem]=useState('');
  const canvas=useRef(null),drag=useRef(null),box=layout.boxes[index];
  const change=patch=>setLayout({...layout,boxes:layout.boxes.map((b,i)=>i===index?{...b,...patch}:b)});
  async function save(next) {
    validateLettering(panel,next);
    // Manual unlock remains available, while AI plans enforce locks.
    const p=setLettering(current.current,panel.id,next),pg=p.layout.pages[pageIndex];
    await pagePNG(pagePanels(p,pg),p.snapshots,p.localizations,p.output_locale,pg,true,p.layout.imageCrops);
    await commit(p);
  }
  useEffect(()=>{
    let stale=false;
    async function paint() {
      const ctx=canvas.current?.getContext('2d');if(!ctx)return;
      ctx.clearRect(0,0,720,720);ctx.fillStyle='#f5f3ef';ctx.fillRect(0,0,720,720);
      if(panel.image){const im=await imageOf(panel.image);if(stale)return;const fit=containRect(im.width,im.height,716,716);ctx.drawImage(im,2+fit.x,2+fit.y,fit.width,fit.height);}
      const p=current.current,snapshot=p.snapshots.find(s=>s.id===panel.snapshotId),localization=p.output_locale==='en'?p.localizations.find(l=>l.snapshot_id===panel.snapshotId&&l.locale==='en'):null;
      if(p.output_locale==='en'&&!localization)throw Error('英訳未作成');
      for(const b of layout.boxes)drawLettering(ctx,textForPanel({...panel,unitIds:[b.unit_id]},snapshot,localization),{x:2+b.x*716,y:2+b.y*716,width:b.width*716,height:b.height*716},true,b);
      setProblem('');
    }
    if(layout.mode==='balloons')paint().catch(e=>{if(!stale)setProblem(e.message);});
    return ()=>{stale=true;};
  },[layout,panel.image]);
  function point(e){const r=e.currentTarget.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];}
  function reset(){if(drag.current){setLayout(drag.current.before);drag.current=null;}}
  return <fieldset className="shot-controls" disabled={busy}><legend>文字配置</legend>
    <label>配置方法<select value={layout.mode} onChange={e=>setLayout({...layout,mode:e.target.value})}><option value="caption">絵の下に本文</option><option value="balloons">コマ内の文字枠</option></select></label>
    {layout.mode==='balloons'&&box&&<>
      <div className="lettering-stage"><canvas ref={canvas} width="720" height="720"/>
        <svg viewBox="0 0 1 1" tabIndex="0" aria-label="吹き出し直接編集" onKeyDown={e=>{if(e.key==='Escape')reset();}}
          onPointerMove={e=>{const d=drag.current;if(!d||busy)return;const [x,y]=point(e),b=d.before.boxes[d.index],next=structuredClone(d.before),n=next.boxes[d.index],clamp=(v,min,max)=>Math.max(min,Math.min(max,v));if(d.kind==='tail')n.tail=[x,y];else if(d.kind==='resize'){n.width=clamp(b.width+x-d.start[0],.08,1-b.x);n.height=clamp(b.height+y-d.start[1],.06,1-b.y);}else{n.x=clamp(b.x+x-d.start[0],0,1-b.width);n.y=clamp(b.y+y-d.start[1],0,1-b.height);}setLayout(next);}}
          onPointerCancel={reset} onLostPointerCapture={reset} onPointerUp={()=>{const d=drag.current;if(!d)return;drag.current=null;if(JSON.stringify(d.before)===JSON.stringify(layout))return;run('文字配置を保存中',async()=>{if(d.base!==editBase(current.current))throw Error('編集中に作品が変わりました');await save(layout);});}}>
          {layout.boxes.map((b,i)=><g key={b.unit_id} onPointerDown={e=>{e.preventDefault();setIndex(i);if(busy||b.locked)return;const svg=e.currentTarget.ownerSVGElement;svg.focus();svg.setPointerCapture(e.pointerId);const r=svg.getBoundingClientRect();drag.current={before:structuredClone(layout),index:i,start:[(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height],kind:e.target.dataset.kind??'move',base:editBase(current.current)};}}>
            <rect data-testid={`letter-box-${i}`} x={b.x} y={b.y} width={b.width} height={b.height} fill="transparent" stroke={i===index?'#e36e42':'#888'} strokeWidth=".003"/>
            {i===index&&!b.locked&&<><rect data-kind="resize" x={b.x+b.width-.013} y={b.y+b.height-.013} width=".026" height=".026" fill="#e36e42"/>{b.tail&&<circle data-kind="tail" cx={b.tail[0]} cy={b.tail[1]} r=".018" fill="#176c79"/>}</>}
          </g>)}
        </svg></div>
      {problem&&<p role="alert">{problem}</p>}
      <label>原文の段落<select value={index} onChange={e=>setIndex(Number(e.target.value))}>{layout.boxes.map((b,i)=><option key={b.unit_id} value={i}>{i+1} · {b.unit_id}</option>)}</select></label>
      {[['x','横位置',0,1,.01],['y','縦位置',0,1,.01],['width','幅',.08,1,.01],['height','高さ',.06,1,.01],['fontSize','文字サイズ',14,72,1],['lineHeight','行間',1,2,.05],['padding','余白',0,40,1]].map(([key,label,min,max,step])=><label key={key}>{label}<input aria-label={label} disabled={box.locked} type="number" min={min} max={max} step={step} value={box[key]??({fontSize:24,lineHeight:1.25,padding:12}[key])} onChange={e=>change({[key]:Number(e.target.value)})}/></label>)}
      <label>形状<select disabled={box.locked} value={box.shape??'round'} onChange={e=>change({shape:e.target.value})}><option value="round">角丸</option><option value="rect">長方形</option><option value="ellipse">楕円</option></select></label>
      <label><input type="checkbox" checked={!!box.locked} onChange={e=>change({locked:e.target.checked})}/>この吹き出しを固定</label>
      <button disabled={box.locked} onClick={()=>change({tail:box.tail?null:[Math.min(1,box.x+box.width/2),Math.min(1,box.y+box.height+.08)]})}>{box.tail?'しっぽを外す':'しっぽを付ける'}</button>
    </>}
    <button onClick={()=>run('文字配置を保存中',()=>save(layout))}>文字配置を適用</button>
    <button disabled={!model?.connectionId} onClick={()=>run('文字配置を提案中',async()=>{const p=current.current,base=editBase(p);const visual=model.visualEditing?await recognizeRegions(p,[panel.id],'文字配置で顔・手・重要な描写を避ける',(prompt,schema,images)=>askLLM(model,{purpose:'vision',prompt,schema,images}),imageOf):null;const value=await proposeLettering(p,panel,'文字量に合わせて整えて', (prompt,schema)=>askLLM(model,{purpose:'lettering',prompt,schema}),visual);await commit(executeLocalEdits(current.current,{base,context:editContext(p,pageIndex,panel.id,null),plan:{reason:'AI文字配置',operations:[{kind:'lettering',panelId:panel.id,args:value}]}}));})}>AIで文字を配置</button>
    <small>ドラッグは1操作で保存。Escapeで取消。本文と順序を保持します。画像送信を有効にすると認識した顔・手の領域を避けます。認識結果の見た目も確認してください。</small>
  </fieldset>;
}
