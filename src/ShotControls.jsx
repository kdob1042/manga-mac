import {sceneBriefArchive} from './scene-brief';
import {download} from './export';
import {captureAngles} from './live-angles';
import React, { useEffect, useState, useRef } from 'react';
import { call } from './bridge';
import { recordLiveCandidate, adoptLiveCandidate, recordLiveVideoCapture } from './live-candidates';
import { liveCall, liveWork, directoryWork, openLiveShot, handoffLive, yieldLive, verifyLiveMappings, assertLiveTarget, createLiveBinding } from './live-blender';
export default function ShotControls({ project, current, commit, chosen, busy, run, scopeType = 'panel', captureSize, cancelled=()=>false }) {
  const [message,setMessage]=useState(''),[preview,setPreview]=useState(null),[observed,setObserved]=useState(null);
  const [character,setCharacter]=useState(''),[object,setObject]=useState('');
  const [width,setWidth]=useState(768),[height,setHeight]=useState(768);
  const video=scopeType==='videoSource';
  const stopAngles=useRef(false);
  const [angleTarget,setAngleTarget]=useState(''),[angleText,setAngleText]=useState('-30,0,30'),[anglePreviews,setAnglePreviews]=useState([]);
  const [workspace,setWorkspace]=useState(null),[template,setTemplate]=useState('');
  useEffect(()=>{setMessage('');setPreview(null);setObserved(null);setCharacter('');setObject('');setWorkspace(null);setTemplate('');setAngleTarget('');setAnglePreviews([]);stopAngles.current=true;},[chosen?.id]);
  const updateTarget=async fn=>{const p=current.current;await commit(video?{...p,shot_batches:p.shot_batches.map(b=>b.scope_type==='videoSource'?{...b,bindings:b.bindings.map(s=>s.id===chosen.id?fn(s):s)}:b)}:{...p,panels:p.panels.map(s=>s.id===chosen.id?fn(s):s)});};
  const read=async()=>{
    let state=await liveCall(call,current.current,'observe',{scope:'summary'}),objects=[...state.objects];
    // Fetch all object identities for explicit assignment, not for the LLM prompt.
    for(let offset=state.next_offset;offset!==null&&offset!==undefined;){
      const page=await liveCall(call,current.current,'observe',{scope:'summary',offset});
      if(page.epoch!==state.epoch||page.revision!==state.revision)throw Error('観測中に状態が変わりました。再観測してください');
      objects.push(...page.objects);offset=page.next_offset;
    }
    state={...state,objects};setObserved(state);return state;
  };
  const exportBrief=async toCodex=>{
    try {
      await handoffLive(call,current.current);
      const state=await read(),p=current.current,shot=p.panels.find(x=>x.id===chosen.id);
      const archive=await sceneBriefArchive(p,shot,state);
      const path=await download(archive,`scene-brief-${crypto.randomUUID()}.zip`);
      if(toCodex)await yieldLive(call,current.current);
      setMessage(`制作依頼: ${path??'ダウンロード済み'}。原文・参照画像・作業ファイル情報を含みます。${toCodex?'MacのCodexへこのZIPを渡してください。MCPの占有も解放しました。':'人が同じBlenderで編集できます。'} 編集後は操作権を戻して再観測してください。`);
    } catch(e){setMessage(e.message);}
  };
  if(!chosen)return <section><h3>Blenderで構図・撮影</h3><p>対象コマを選択し、設定からBlender GUIへ接続してください。</p></section>;
  return <section className="shot-controls" aria-label="Blenderショット"><h3>Blenderで構図・撮影 · GUI</h3>
    <button disabled={busy} onClick={()=>run('Blenderの素材フォルダを準備中',async()=>setWorkspace(await call('blender_workspace',{input:{directory_work:directoryWork(current.current),scope:`${scopeType}:${chosen.id}`,open_assets:true}})))}>素材フォルダを開く・再読込</button>
    {workspace&&<><p>素材: {workspace.assets}<br/>作業: {workspace.working}</p><label>初回に使うblend<select value={template} onChange={e=>setTemplate(e.target.value)}><option value="">新しいシーン</option>{workspace.templates.map(name=><option key={name} value={name}>{name}</option>)}</select></label><small>保存済みの作業ファイルがあれば続きから開きます。素材の原本は上書きしません。</small></>}
    <button disabled={busy} onClick={()=>run('Blender GUIを開いて接続中',async()=>{const binding=await openLiveShot(call,current.current,chosen,{template,scopeType});await updateTarget(p=>({...p,live_binding:binding}));setMessage('このコマの作業ファイルをGUIで開きました。素材はBlenderのAsset Browserで利用できます。');})}>この{video?'撮影':'コマ'}のBlenderを開く</button>
    <button disabled={busy} onClick={()=>run('live対象を確認中',async()=>{const s=await read();await updateTarget(p=>({...p,live_binding:createLiveBinding(current.current,p,s)}));setMessage('このGUIを対象へ割り当てました。manga-macから自然言語で操作できます。');})}>この{video?'撮影':'コマ'}を接続中のlive状態へ割り当てる</button>
    {chosen.live_binding&&<>
      <button disabled={busy} onClick={()=>run('作業ファイルを保存中',async()=>{await handoffLive(call,current.current);const expected=await read();assertLiveTarget(chosen.live_binding,expected);await liveCall(call,current.current,'save_working',{expected});setMessage('作業ファイルを保存しました。撮影候補・採用版は変更していません。');})}>作業ファイルを保存</button>
      <p>LIVE: {chosen.live_binding.file||'未保存'} ／ {chosen.live_binding.scene}</p>
      <button onClick={async()=>{try{await handoffLive(call,current.current);setMessage('手動編集へ引継ぎ済み。AIの未送信計画は破棄しました。');}catch(e){setMessage(e.message);}}}>手動へ渡す（AI書込み停止）</button>
      <button onClick={()=>video?yieldLive(call,current.current).then(()=>setMessage('MacのCodexへ引継ぎ済み')).catch(e=>setMessage(e.message)):exportBrief(true)}>MacのCodexへ渡す</button>
      {!video&&<button onClick={()=>exportBrief(false)}>人へ渡す制作依頼を書き出す</button>}
      <button disabled={busy} onClick={()=>run('操作権を戻して再観測中',async()=>{
        await liveCall(call,current.current,'reclaim');const s=await read();assertLiveTarget(chosen.live_binding,s);verifyLiveMappings(current.current,chosen,s);
        setPreview(await liveCall(call,current.current,'observe',{scope:'camera'}));setMessage('再観測済み。manga-macの演出指示から新しい計画で再開できます。');
      })}>操作権を戻し、再観測する</button>
      {['viewport','camera'].map(scope=><button key={scope} disabled={busy} onClick={()=>run('GUI画像を取得中',async()=>setPreview(await liveCall(call,current.current,'observe',{scope})))}>{scope==='viewport'?'Viewportを確認':'Cameraを確認'}</button>)}
      {!!chosen.characterIds?.length&&<><button disabled={busy} onClick={()=>run('人物対応を確認中',read)}>人物の対応先を読み込む</button>
        <label>人物<select aria-label="人物" value={character} onChange={e=>setCharacter(e.target.value)}><option value="">選択</option>{chosen.characterIds.map(id=><option key={id} value={id}>{project.characters.find(c=>c.id===id)?.name??id}</option>)}</select></label>
        <label>BlenderのObject<select aria-label="BlenderのObject" value={object} onChange={e=>setObject(e.target.value)}><option value="">選択</option>{observed?.objects.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <button disabled={busy||!character||!object} onClick={()=>run('人物と素材を対応付け',async()=>{
          const s=await read();assertLiveTarget(chosen.live_binding,s);const o=s.objects.find(o=>o.id===object);if(!o)throw Error('Objectが変わりました');
          await updateTarget(p=>({...p,live_binding:{...p.live_binding,objects:s.objects,character_objects:[...(p.live_binding.character_objects??[]).filter(x=>x.character_id!==character),{character_id:character,object_name:o.name,object_id:o.id}]}}));
        })}>人物と素材を対応付ける</button></>}
      {!video&&<details><summary>同じシーンのアングル候補を作る</summary>
        <p>指定Objectの原点を注視し、現在のカメラ位置を中心に左右へ回り込んで撮影します。同じScene・frameを使い、撮影後は元のカメラ位置へ戻ります。</p>
        <button disabled={busy} onClick={()=>run('注視対象を確認中',read)}>注視対象を読み込む</button>
        <label>注視対象<select aria-label="注視対象" value={angleTarget} onChange={e=>setAngleTarget(e.target.value)}><option value="">選択</option>{observed?.objects.filter(o=>o.type!=='CAMERA').map(o=><option key={o.id} value={o.name}>{o.name}</option>)}</select></label>
        <label>角度（度、カンマ区切り・最大5個）<input value={angleText} onChange={e=>setAngleText(e.target.value)}/></label>
        <button disabled={busy||!angleTarget} onClick={()=>run('アングル候補を撮影中',async()=>{
          stopAngles.current=false;setAnglePreviews([]);
          await captureAngles({current:()=>current.current,commit,call,panelId:chosen.id,targetObject:angleTarget,degrees:angleText.split(',').filter(s=>s.trim()).map(Number),width,height,cancelled:()=>stopAngles.current||cancelled(),notify:setMessage,onCapture:p=>setAnglePreviews(old=>[...old,p])});
          setMessage('アングル候補を保存しました。比較して採用できます。元のカメラ位置は保持しています。');
        })}>アングル候補を撮影</button>
        <button disabled={!busy} onClick={()=>{stopAngles.current=true;setMessage('現在の撮影が終わったら停止します。完成済みの候補は残ります。');}}>連続撮影を停止</button>
        <div style={{display:'flex',flexWrap:'wrap',gap:12}}>{anglePreviews.map(p=><figure key={p.id} style={{margin:0,width:180}}><img src={p.preview} alt={`${p.angle}度の候補`} style={{width:'100%'}}/><figcaption>{p.angle}°<button disabled={busy} onClick={()=>run('候補を採用中',()=>commit(adoptLiveCandidate(current.current,p.id)))}>この角度を採用</button></figcaption></figure>)}</div>
      </details>}
      {!video&&<><label>撮影幅<input type="number" min="64" max="4096" value={width} onChange={e=>setWidth(Number(e.target.value))}/></label><label>撮影高さ<input type="number" min="64" max="4096" value={height} onChange={e=>setHeight(Number(e.target.value))}/></label></>}
      <button disabled={busy} onClick={()=>run('Blender GUIで撮影・候補保存中（編集は完了までお待ちください）',async()=>{
        const base=video?current.current.shot_batches.flatMap(b=>b.bindings).find(s=>s.id===chosen.id):current.current.panels.find(p=>p.id===chosen.id);
        await handoffLive(call,current.current);const s=await read();assertLiveTarget(base.live_binding,s);verifyLiveMappings(current.current,base,s);
        const result=await call('blender_live_candidate',{input:{work:liveWork(current.current),expected:s,width:captureSize?.[0]??width,height:captureSize?.[1]??height}});
        await commit(await (video?recordLiveVideoCapture:recordLiveCandidate)(current.current,chosen.id,result,base));setPreview(result);setMessage('GUIで撮影した新しい版を保存しました。旧採用版は保持しています。');
      })}>見た目を確認し、新しい候補版へ保存</button>
    </>}
    <p>{message}</p>{preview&&<img className="shot-preview" src={preview.image??preview.preview} alt={preview.image_kind??'保存した候補画像'}/>}
    {!video&&(project.live_candidates??[]).filter(c=>c.panel_id===chosen.id).map(c=><div key={c.id}><span>候補 {c.label??c.id.slice(-8)}</span><button disabled={busy} onClick={()=>run('候補を表示中',async()=>{const x=current.current.captures.find(x=>x.id===c.capture_revision);setPreview(await call('blender_capture',{sessionId:x.session_id,requestId:x.request_id}));})}>候補を表示</button><button disabled={busy} onClick={()=>run('候補を採用中',()=>commit(adoptLiveCandidate(current.current,c.id)))}>この候補を採用</button></div>)}
    {chosen.capture_revision&&<button disabled={busy} onClick={()=>run('作業用コピーを書き出し中',async()=>{const c=current.current.captures.find(c=>c.id===chosen.capture_revision);const path=await call('blender_working_copy',{sessionId:c.session_id,requestId:c.request_id});setMessage(`作業用コピー: ${path}。現在の作業を保存してからBlenderで開き、再接続・再割当してください。`);})}>採用中の版を作業用コピーへ書き出す</button>}
    {chosen.capture_revision&&<button disabled={busy} onClick={()=>run('採用中の撮影を表示中',async()=>{const c=current.current.captures.find(c=>c.id===chosen.capture_revision);setPreview(await call('blender_capture',{sessionId:c.session_id,requestId:c.request_id}));})}>採用中の撮影原本を表示</button>}
    {(project.live_directing_runs??[]).filter(r=>r.panel_id===chosen.id).slice(-1).map(r=><div key={r.id}><p>{r.status}：{r.message}</p>{r.preview&&<img className="shot-preview" src={r.preview} alt={r.image_kind}/>}</div>)}
  </section>;
}
