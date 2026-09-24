import React, {Suspense, lazy, useCallback, useMemo, useRef, useState} from 'react';
import {createScene,updatePanelScene,validateScene} from './scene-model.js';
import {importSceneGlb} from './scene-assets.js';
import {recordSceneCapture} from './scene-capture.js';
import {askLLM} from './llm.js';
import {bounds,PAGE} from './layout.js';
import ScenePoseControls from './ScenePoseControls.jsx';
const SceneViewport=lazy(()=>import('./SceneViewport.jsx'));

const decimal=(form,name)=>Number(form.get(name));
const triplet=(form,prefix)=>[0,1,2].map(i=>decimal(form,`${prefix}${i}`));
const noAssets=[];
function suggestedSize(project,panelId){
  const slot=project.layout?.pages.flatMap(page=>page.slots).find(item=>item.panelId===panelId);
  if(!slot?.points)return [768,768];
  const box=bounds(slot.points),ratio=box.width*PAGE.width/(box.height*PAGE.height);
  return ratio>=1?[1024,Math.max(64,Math.round(1024/ratio))]:[Math.max(64,Math.round(1024*ratio)),1024];
}
export default function SceneControls({project,panel,current,commit,run,busy,model,active=true}){
  const [opened,setOpened]=useState(false),[selected,setSelected]=useState(''),[newAsset,setNewAsset]=useState(''),[assetKind,setAssetKind]=useState('prop'),[instruction,setInstruction]=useState(''),[rigInfo,setRigInfo]=useState({}),[captureWidth,setCaptureWidth]=useState(()=>suggestedSize(project,panel.id)[0]),[captureHeight,setCaptureHeight]=useState(()=>suggestedSize(project,panel.id)[1]);
  const viewport=useRef(null),blank=useMemo(createScene,[]),scene=panel.scene3d??blank;
  const assets=project.sceneAssets??noAssets;
  const chosen=scene.objects.find(item=>item.id===selected)??scene.objects[0];
  const update=operation=>run('3D構図を保存中',()=>commit(updatePanelScene(current.current,panel.id,operation)));
  const saveCamera=useCallback(camera=>{
    if(!busy)run('カメラを保存中',()=>commit(updatePanelScene(current.current,panel.id,{type:'camera',camera})));
  },[busy,run,commit,current,panel.id]);
  const applyInstruction=()=>run('3D構図を提案中',async()=>{
    if(!model?.connectionId)throw Error('演出AIの接続を設定してください');
    const base=current.current,shot=base.panels.find(item=>item.id===panel.id),before=shot.scene3d??createScene();
    const sceneBefore=JSON.stringify(before),assetBefore=JSON.stringify(base.sceneAssets??[]);
    const prompt=`対象コマの3D構図に対して一つだけ型付き操作を提案してください。任意コードは出力しません。Yが上、回転はラジアン。操作は add/remove/transform/pose/camera のいずれか。素材一覧: ${JSON.stringify((base.sceneAssets??[]).map(({id,name,kind})=>({id,name,kind})))}。現在のscene3d: ${sceneBefore}。指示: ${instruction}`;
    const schema={type:'object',properties:{type:{type:'string',enum:['add','remove','transform','pose','camera']},id:{type:'string'},object:{type:'object'},position:{type:'array',items:{type:'number'}},rotation:{type:'array',items:{type:'number'}},scale:{type:'array',items:{type:'number'}},pose:{type:'object'},contacts:{type:'array'},camera:{type:'object'}},required:['type'],additionalProperties:false};
    const op=JSON.parse(await askLLM(model,{purpose:'scene',prompt,schema}));
    const latest=current.current;
    if(JSON.stringify(latest.panels.find(item=>item.id===panel.id)?.scene3d??createScene())!==sceneBefore || JSON.stringify(latest.sceneAssets??[])!==assetBefore)throw Error('提案中に構図または素材が変わりました。もう一度指示してください');
    await commit(updatePanelScene(latest,panel.id,op));setInstruction('');
  });
  if(!active)return null;
  if(!opened)return <section className="scene-controls"><button disabled={busy} onClick={()=>setOpened(true)}>3D構図を開く</button>{panel.scene3d&&<small>保存済み構図あり</small>}</section>;
  return <section className="scene-controls" aria-label="3D構図編集">
    <div className="scene-heading"><h3>3D構図 · このコマ</h3><button onClick={()=>setOpened(false)}>閉じる</button></div>
    <Suspense fallback={<p role="status">3D画面を読み込み中…</p>}><SceneViewport ref={viewport} scene={scene} assets={assets} onCamera={saveCamera} onRigInfo={setRigInfo}/></Suspense>
    <p className="muted">ドラッグで視点、ホイールで距離を変更。視点と配置はコマごとに保存されます。</p>
    <div className="scene-actions"><label>素材<select aria-label="追加する3D素材" value={newAsset} onChange={e=>setNewAsset(e.target.value)}><option value="">選択</option>{assets.map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
      <button disabled={!!busy||!newAsset} onClick={()=>update({type:'add',object:{id:crypto.randomUUID(),assetId:newAsset,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}})}>配置</button>
      <label className="scene-import">GLBを追加<input type="file" accept=".glb,model/gltf-binary" disabled={!!busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)run('3D素材を取り込み中',async()=>{const result=await importSceneGlb(current.current,{file,kind:assetKind,name:file.name});await commit(result.project);setNewAsset(result.asset.id);});}}/></label>
      <label>種類<select aria-label="素材の種類" value={assetKind} onChange={e=>setAssetKind(e.target.value)}><option value="prop">小物</option><option value="character">人物</option><option value="environment">背景</option></select></label>
    </div>
    {!!scene.objects.length&&<div className="scene-actions"><label>配置済み<select aria-label="配置済み3D素材" value={chosen?.id??''} onChange={e=>setSelected(e.target.value)}>{scene.objects.map(item=><option value={item.id} key={item.id}>{assets.find(asset=>asset.id===item.assetId)?.name??item.assetId} · {item.id.slice(0,6)}</option>)}</select></label><button disabled={!!busy} onClick={()=>update({type:'remove',id:chosen.id})}>取り除く</button></div>}
    {chosen&&<form key={chosen.id+JSON.stringify([chosen.position,chosen.rotation,chosen.scale])} className="scene-transform" onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);update({type:'transform',id:chosen.id,position:triplet(form,'p'),rotation:triplet(form,'r').map(n=>n*Math.PI/180),scale:triplet(form,'s')});}}>
      {[["位置 m",'p',chosen.position],["角度 °",'r',chosen.rotation.map(n=>n*180/Math.PI)],["倍率",'s',chosen.scale]].map(([label,prefix,values])=><fieldset key={prefix}><legend>{label}</legend>{values.map((value,i)=><label key={i}>{['X','Y','Z'][i]}<input name={`${prefix}${i}`} aria-label={`${label} ${['X','Y','Z'][i]}`} type="number" step="0.01" defaultValue={Number(value.toFixed(3))}/></label>)}</fieldset>)}
      <button disabled={!!busy}>配置を保存</button>
    </form>}
    <ScenePoseControls scene={scene} assets={assets} chosen={chosen} rigInfo={rigInfo[chosen?.id]} update={update} busy={busy}/>
    <div className="scene-actions"><input aria-label="3D構図への指示" placeholder="例: カメラを低く" value={instruction} onChange={e=>setInstruction(e.target.value)}/><button disabled={!!busy||!instruction.trim()} onClick={applyInstruction}>AIに構図を指示</button></div>
    <div className="scene-actions"><label>撮影幅<input type="number" min="64" max="4096" step="1" value={captureWidth} onChange={e=>setCaptureWidth(Number(e.target.value))}/></label><label>撮影高さ<input type="number" min="64" max="4096" step="1" value={captureHeight} onChange={e=>setCaptureHeight(Number(e.target.value))}/></label>
      <button disabled={!!busy} onClick={()=>run('構図を撮影中',async()=>{const shown=JSON.stringify(scene),base=current.current;
        if(JSON.stringify(base.panels.find(item=>item.id===panel.id)?.scene3d??createScene())!==shown)throw Error('表示中の構図が保存版と異なります。読み込み直してください');
        validateScene(scene,new Set((base.sceneAssets??[]).map(asset=>asset.id)));
        const png=await viewport.current.capture({width:captureWidth,height:captureHeight});
        if(JSON.stringify(current.current.panels.find(item=>item.id===panel.id)?.scene3d??createScene())!==shown)throw Error('撮影中に構図が変わりました。再撮影してください');
        await commit(await recordSceneCapture(current.current,panel.id,png,captureWidth,captureHeight));
      })}>構図画像を撮影</button></div>
  </section>;
}
