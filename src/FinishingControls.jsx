import React,{useEffect,useState} from 'react';
import {call,desktop} from './bridge';
import {imageOf,pagePNG} from './render';
import {pagePanels} from './layout.js';
import {beginFinishing,finishingPlan,finishingInstruction} from './finishing.js';
import {placementKey} from './placement.js';
import {generatePanel} from './pipeline';
import {finishJob,adoptCandidate,abandonJob} from './revisions.js';
import {recoverImageResult} from './image-recovery';

function PlacementComparison({project,panel,artwork}) {
  const [images,setImages]=useState(null),[error,setError]=useState('');
  useEffect(()=>{
    let stopped=false;setImages(null);setError('');
    const page=project.layout.pages.find(p=>p.slots.some(s=>s.panelId===panel.id));
    if(page)Promise.all([project,{...project,panels:project.panels.map(p=>p.id===panel.id?artwork.panel:p)}].map(p=>pagePNG(pagePanels(p,page),p.snapshots,p.localizations,p.output_locale,page,true,p.layout.imageCrops)))
      .then(value=>{if(!stopped)setImages(value);}).catch(e=>{if(!stopped)setError(e.message);});
    return()=>{stopped=true;};
  },[project,panel,artwork]);
  return <>{error&&<p role="alert">配置プレビュー：{error}</p>}{images&&<div className="upscale-compare">{images.map((src,i)=><figure key={i}><img src={src} alt={i?'配置した仕上げ候補':'現在の配置'}/><figcaption>{i?'再生成候補（現在の配置）':'現在の原稿'}</figcaption></figure>)}</div>}</>;
}
export default function FinishingControls({project,panel,current,commit,run,busy}) {
  const [plan,setPlan]=useState(null),[error,setError]=useState('');
  useEffect(()=>{
    let stopped=false;setPlan(null);setError('');
    if(panel.image)imageOf(panel.image).then(im=>{const next=finishingPlan(project,panel.id,im.width,im.height);if(!stopped)setPlan(next);}).catch(e=>{if(!stopped)setError(e.message);});
    return()=>{stopped=true;};
  },[project.layout,panel.image,panel.id]);
  const jobs=project.jobs.filter(j=>j.finishing&&j.panelId===panel.id&&['candidate','unknown'].includes(j.status));
  async function prepare(){
    const p=current.current,source=p.panels.find(x=>x.id===panel.id),im=await imageOf(source.image);
    const job=await beginFinishing(p,panel.id,im.width,im.height);
    await commit({...p,jobs:[...p.jobs,job]});
    try {
      const result=await generatePanel(source,p.characters,source.image,finishingInstruction(job),job,null,p.style_references??[]);
      await commit(await finishJob(current.current,job,result,false,true));
    }catch(e){await commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'unknown'}:j)});throw e;}
  }
  return <section className="shot-controls" aria-label="配置に合わせた仕上げ"><h3>配置に合わせた仕上げ</h3>
    <p>拡大・縮小・位置は「画像トリミング」で調整します。配置は固定したまま、元画像と人物・画風参照を使って絵を再生成できます。構図や細部の一致は保証されないため、比較して採用してください。枠・セリフ・吹き出しは生成画像へ焼き込みません。</p>
    {error&&<p>{error}</p>}
    {plan&&<><p>元画像 {plan.sourceWidth} × {plan.sourceHeight} px ／ 配置に必要な原画像サイズ {plan.requiredWidth} × {plan.requiredHeight} px</p>
      <p>{plan.sourceSufficient?'現在の画像は画素数を満たしています。縮小は出力時に行うため、再生成は不要です。':'現在の画像は配置に対して解像度が不足しています。'}</p>
      <p>再生成サイズ {plan.width} × {plan.height} px（元画像と同じ縦横比）</p>
      {!plan.sufficient&&<p role="status">必要サイズがエンジン上限1024pxを超えています。この候補を採用しても解像度不足は解消しません。配置の拡大率を下げるか、今後の高解像度エンジン対応が必要です。</p>}</>}
    <button disabled={busy||!plan||!desktop()} onClick={()=>run('配置に合わせて再生成',prepare)}>元画像を参照して仕上げ候補を作る</button>
    {!desktop()&&<small>再生成はMacアプリの既存画像モデルを使用します。</small>}
    {jobs.map(j=>{const artwork=project.artworks.find(a=>a.id===j.output_revision),stale=j.placement_key!==placementKey(project,panel.id);return <div key={j.id}>
      {j.status==='candidate'&&artwork?<><PlacementComparison project={project} panel={panel} artwork={artwork}/>{stale&&<p>候補作成後に配置が変わったため採用できません。</p>}
        <button disabled={busy||stale} onClick={()=>run('仕上げ候補を採用',async()=>commit(await adoptCandidate(current.current,j.id)))}>この仕上げ候補を採用</button></>:<><p>応答未確定です。元画像は保持されています。保存済みの結果を回収できる場合があります。</p>
        <button disabled={busy||!desktop()} onClick={()=>run('仕上げ結果を回収',async()=>{const receipt=await call('recover_image',{jobId:j.id});await commit(await recoverImageResult(current.current,j.id,receipt));})}>保存済み仕上げを回収する</button></>}
      <button disabled={busy} onClick={()=>run('仕上げ要求を取り下げ',()=>commit(abandonJob(current.current,j.id)))}>この仕上げ要求を取り下げる</button>
    </div>;})}
  </section>;
}
