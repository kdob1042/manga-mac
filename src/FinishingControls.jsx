import { prepareFinishing } from './panel-actions';
import React,{useEffect,useState} from 'react';
import {call,desktop} from './bridge';
import { imageOf } from './canvas-image.js';
import { pagePNG } from './render.js';
import {pagePanels} from './layout.js';
import {finishingPlan} from './finishing.js';
import {placementKey} from './placement.js';
import {adoptCandidate,abandonJob} from './revisions.js';
import {recoverImageResult} from './image-recovery';

function PlacementComparison({project,panel,artwork,active=true}) {
  const [images,setImages]=useState(null),[error,setError]=useState('');
  useEffect(()=>{
    if(!active)return;
    let stopped=false;setImages(null);setError('');
    const page=project.layout.pages.find(p=>p.slots.some(s=>s.panelId===panel.id));
    if(page)Promise.all([project,{...project,panels:project.panels.map(p=>p.id===panel.id?artwork.panel:p)}].map(p=>pagePNG(pagePanels(p,page),p.snapshots,p.localizations,p.output_locale,page,true,p.layout.imageCrops)))
      .then(value=>{if(!stopped)setImages(value);}).catch(e=>{if(!stopped)setError(e.message);});
    return()=>{stopped=true;};
  },[active,project.layout,project.panels,project.snapshots,project.localizations,project.output_locale,panel.id,artwork.panel]);
  return <>{error&&<p role="alert">配置プレビュー：{error}</p>}{images&&<div className="upscale-compare">{images.map((src,i)=><figure key={i}><img src={src} alt={i?'配置した仕上げ候補':'現在の配置'}/><figcaption>{i?'再生成候補（現在の配置）':'現在の原稿'}</figcaption></figure>)}</div>}</>;
}
export default function FinishingControls({project,panel,current,commit,run,busy,imageModelId,active=true}) {
  const [plan,setPlan]=useState(null),[error,setError]=useState('');
  useEffect(()=>{
    if(!active)return;
    let stopped=false;setPlan(null);setError('');
    if(panel.image)imageOf(panel.image).then(im=>{const next=finishingPlan(project,panel.id,im.width,im.height,imageModelId);if(!stopped)setPlan(next);}).catch(e=>{if(!stopped)setError(e.message);});
    return()=>{stopped=true;};
  },[active,project.layout,panel.image,panel.id,imageModelId]);
  const jobs=project.jobs.filter(j=>j.finishing&&j.panelId===panel.id&&['candidate','unknown'].includes(j.status));
  const prepare=()=>prepareFinishing(()=>current.current,commit,panel.id,imageModelId);
  return <section className="shot-controls" aria-label="配置に合わせた仕上げ"><h3>配置に合わせた仕上げ</h3>
    <p>配置と文字を保ち、元画像を参照して描き直します。構図や細部が変わるため、比較して採用してください。</p>
    {error&&<p>{error}</p>}
    {plan&&<><p>元画像 {plan.sourceWidth} × {plan.sourceHeight} px ／ 配置に必要な原画像サイズ {plan.requiredWidth} × {plan.requiredHeight} px</p>
      <p>{plan.sourceSufficient?'解像度は足りています。そのまま出力できます。':'この配置では解像度が不足しています。'}</p>
      <p>再生成サイズ {plan.width} × {plan.height} px（元画像と同じ縦横比）</p>
      {!plan.sufficient&&<p role="status">必要サイズがエンジン上限{plan.engineMax}pxを超えています。再生成しても不足するため、配置の拡大率を下げてください。</p>}</>}
    <button disabled={busy||!plan||!desktop()} onClick={()=>run('配置に合わせて再生成',prepare)}>元画像を参照して仕上げ候補を作る</button>
    {!desktop()&&<small>再生成はMacアプリの既存画像モデルを使用します。</small>}
    {jobs.map(j=>{const artwork=project.artworks.find(a=>a.id===j.output_revision),stale=j.placement_key!==placementKey(project,panel.id);return <div key={j.id}>
      {j.status==='candidate'&&artwork?<><PlacementComparison project={project} panel={panel} artwork={artwork} active={active}/>{stale&&<p>候補作成後に配置が変わったため採用できません。</p>}
        <button disabled={busy||stale} onClick={()=>run('仕上げ候補を採用',async()=>commit(await adoptCandidate(current.current,j.id)))}>この仕上げ候補を採用</button></>:<><p>応答未確定です。元画像は保持されています。保存済みの結果を回収できる場合があります。</p>
        <button disabled={busy||!desktop()} onClick={()=>run('仕上げ結果を回収',async()=>{const receipt=await call('recover_image',{jobId:j.id});await commit(await recoverImageResult(current.current,j.id,receipt));})}>保存済み仕上げを回収する</button></>}
      <button disabled={busy} onClick={()=>run('仕上げ要求を取り下げ',()=>commit(abandonJob(current.current,j.id)))}>この仕上げ要求を取り下げる</button>
    </div>;})}
  </section>;
}
