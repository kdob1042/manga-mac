import { prepareInterpolation } from './panel-actions';
import React,{useEffect,useState} from 'react';
import { imageOf } from './canvas-image.js';
import {adoptUpscale,discardUpscale,requiredScale,placementKey} from './upscale.js';
export default function UpscaleControls({project,panel,current,commit,run,busy,active=true}) {
  const [size,setSize]=useState(null),[factor,setFactor]=useState(2);
  useEffect(()=>{if(!active)return;let stopped=false;setSize(null);if(panel.image)imageOf(panel.image).then(im=>{if(!stopped)setSize([im.width,im.height]);}).catch(()=>{});return()=>{stopped=true;};},[active,panel.image]);
  const jobs=project.jobs.filter(j=>j.kind==='upscale'&&j.panelId===panel.id&&['candidate','unknown'].includes(j.status));
  const prepare=()=>prepareInterpolation(()=>current.current,commit,panel.id,factor);
  let scale=null;try{if(size)scale=requiredScale(project,panel.id,...size);}catch{}
  return <section className="shot-controls" aria-label="画像の高解像度化"><h3>画像の高解像度化</h3>
    <p>ローカル補間拡大です。AI超解像ではなく、描かれていない細部は復元しません。元画像を残して候補を作り、配置・セリフ・吹き出しは変更しません。</p>
    {size&&<p>元画像 {size[0]} × {size[1]} px{scale!==null&&` ／ 標準幅1600pxで必要な倍率：約${Math.max(1,scale).toFixed(2)}倍`}</p>}
    <label>拡大倍率<select aria-label="高解像度化の倍率" disabled={busy} value={factor} onChange={e=>setFactor(Number(e.target.value))}><option value={2}>2倍</option><option value={4}>4倍</option></select></label>
    <button disabled={busy||!size||scale===null} onClick={()=>run('補間拡大の候補を作成',prepare)}>補間拡大の候補を作る</button>
    {jobs.map(j=><div key={j.id}>{j.status==='candidate'?<><div className="upscale-compare"><figure><img src={panel.image} alt="拡大前の画像"/><figcaption>現在の画像</figcaption></figure><figure><img src={project.artworks.find(a=>a.id===j.output_revision)?.panel.image} alt="補間拡大の候補"/><figcaption>{j.upscale?.width} × {j.upscale?.height} px（補間拡大）</figcaption></figure></div>
      <button disabled={busy||j.placement_key!==placementKey(project,panel.id)} onClick={()=>run('高解像度候補を採用',async()=>commit(await adoptUpscale(current.current,j.id)))}>この高解像度候補を採用</button></>:<p>処理が中断されました。元画像は保持されています。取り下げ後に再実行できます。</p>}
      <button disabled={busy} onClick={()=>run('高解像度候補を取り下げ',()=>commit(discardUpscale(current.current,j.id)))}>この拡大要求を取り下げる</button></div>)}
  </section>;
}
