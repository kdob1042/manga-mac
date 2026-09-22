import LayoutEditor from './LayoutEditor.jsx';
import React, { useMemo, useState, useRef } from 'react';
import { atomize } from '../contracts/name-plan/source.mjs';
import { MAX_BYTES } from '../contracts/name-plan/schema.mjs';
import { FORMAT, createNameCandidate, adoptNameCandidate, editNameCandidateLayout, setNameLock, nameReadToken } from './name-v2.js';
import { generateNameCandidate, proposeNameEdit, applyNameEdit, pageAtomSelection, runNameVisualQA } from './name-v2-ai.js';
import { importNamePlan } from './name-import.js';
import { askLLM } from './llm.js';
import { fetchRepositoryNamePlan } from './name-repository.js';
import { pagePNG } from './render.js';

// Reuses the existing draft, Job, renderer, connection and atomic writer boundaries.
export default function NamePlanControls({project,current,commit,run,busy,model,sceneIds,onSwitch,cancelled=()=>false,sourceToken='',episodeId=''}) {
  const [instruction,setInstruction]=useState(''),[selection,setSelection]=useState(null),[chosen,setChosen]=useState('');
  const [preview,setPreview]=useState(null),[pageIndex,setPageIndex]=useState(0),[width,setWidth]=useState(430);
  const [edit,setEdit]=useState(null),[visionConsent,setVisionConsent]=useState(false),[message,setMessage]=useState('');
  const snapshot=project.snapshots.find(s=>s.id===project.active);
  const atomResult=useMemo(()=>{try{return {atoms:snapshot?atomize(snapshot):[],error:''};}catch(error){return {atoms:[],error:error.message};}},[snapshot]);
  const atoms=atomResult.atoms.filter(atom=>!sceneIds?.length||sceneIds.includes(atom.source.sceneId));
  const selected=selection===null?atoms.map(atom=>atom.id):atoms.filter(atom=>selection.includes(atom.id)).map(atom=>atom.id);
  const candidates=project.jobs.filter(job=>job.kind==='name_plan'&&job.status==='candidate'&&(job.nameCandidate||job.legacyNameRaw));
  const job=candidates.find(job=>job.id===chosen)??candidates.at(-1),candidate=job?.nameCandidate;
  const name=project.namePlan?.format===FORMAT?project.namePlan:null;
  const displayProject=candidate?{...project,panels:candidate.panels,layout:candidate.layout,layoutHistory:candidate.layoutHistory??[],layoutRedo:candidate.layoutRedo??[]}:project;
  const candidateCurrent=useRef(displayProject);candidateCurrent.current=displayProject;
  const pages=candidate?candidate.layout.pages:name?project.layout.pages.filter(page=>name.pageIds.includes(page.id)):[];
  const page=pages[Math.min(pageIndex,Math.max(0,pages.length-1))];
  const connected=!!model?.connectionId;
  const safeRun=(label,fn)=>run(label,async()=>{setMessage('');await fn();});
  const clear=()=>{setPreview(null);setEdit(null);onSwitch?.();};
  async function stageRaw(raw,provenance=null) {
    const base=current.current;let data;
    if(typeof raw!=='string'||new TextEncoder().encode(raw).length>MAX_BYTES)throw Error('ネームJSONは4MiB以内で指定してください');
    try{data=JSON.parse(raw);}catch{throw Error('ネームJSONを読み取れません');}
    const id=crypto.randomUUID();
    const entry={id,kind:'name_plan',status:'candidate',source_revision:base.active,at:new Date().toISOString(),...(provenance?{repositoryPlan:provenance}:{})};
    if(data?.format===FORMAT)entry.nameCandidate=await createNameCandidate(base,data);
    else {await importNamePlan(base,raw);entry.legacyNameRaw=raw;entry.base=await nameReadToken(base);}
    if(current.current!==base)throw Error('ネーム確認中に作品が変わりました');
    await commit({...base,jobs:[...base.jobs,entry]});setChosen(id);setPageIndex(0);setPreview(null);
    setMessage(provenance?'同じGitHub版のネームを候補として保存しました。原稿と配置を確認してから採用してください。':'候補を保存しました。原稿と配置を確認してから採用してください。');
  }
  async function readFile(file) {
    if(!file)return;
    await safeRun('ネームファイルを検査',async()=>{if(file.size>MAX_BYTES)throw Error('ネームJSONは4MiB以内で指定してください');await stageRaw(await file.text());});
  }
  async function readRepositoryPlan() {
    await safeRun('GitHubのネームを取得',async()=>{
      if(!snapshot)throw Error('原稿を先に取り込んでください');
      const base=current.current, fetched=await fetchRepositoryNamePlan(snapshot,episodeId,sourceToken);
      if(current.current!==base||current.current.active!==snapshot.id)throw Error('取得中に作品または原稿版が変わりました');
      await stageRaw(fetched.raw,{repo:fetched.repo,path:fetched.path,commit:fetched.commit,episodeId:fetched.episodeId});
    });
  }
  async function generate(ids=selected,customInstruction=instruction) {
    await safeRun('ネーム候補を生成',async()=>{
      if(!ids.length)throw Error('制作する文章を選んでください');
      const candidate=await generateNameCandidate({current:()=>current.current,commit,ask:askLLM,model,selectedAtomIds:ids,instruction:customInstruction,cancelled,notify:setMessage});
      if(candidate){const j=current.current.jobs.find(j=>j.nameCandidate?.id===candidate.id);setChosen(j?.id??'');setPageIndex(0);setPreview(null);setEdit(null);}
    });
  }
  async function adopt(mode='replace') {
    await safeRun('ネームを採用',async()=>{
      const latest=current.current,j=latest.jobs.find(j=>j.id===job?.id);
      if(!j||j.status!=='candidate')throw Error('候補が変更されました');
      let next;
      if(j.nameCandidate)next=await adoptNameCandidate(latest,j.nameCandidate,mode);
      else {if(j.base!==await nameReadToken(latest))throw Error('旧形式候補の原稿・作品が変わりました');next=await importNamePlan(latest,j.legacyNameRaw);next.jobs=next.jobs.map(job=>job.id===j.id?{...job,status:'complete'}:job);}
      await commit(next);setChosen('');clear();setMessage('ネームを採用しました。「このネームで制作」で作画・文字配置へ進めます。');
    });
  }
  async function proof() {
    await safeRun('仮ネームを描画',async()=>{
      if(!page)throw Error('表示するページがありません');
      const panels=page.slots.map(slot=>displayProject.panels.find(panel=>panel.id===slot.panelId)).filter(Boolean);
      setPreview(await pagePNG(panels,project.snapshots,project.localizations,project.output_locale,page,true,displayProject.layout.imageCrops));
    });
  }
  async function visualQA() {
    await safeRun('ページ画像を確認',async()=>{
      if(!page||!name||candidate)throw Error('採用したネームのページを選んでください');
      if(!visionConsent||!model.visualEditing)throw Error('画像入力対応と送信内容を確認してください');
      const base=current.current,panels=page.slots.map(slot=>base.panels.find(p=>p.id===slot.panelId));
      const image=await pagePNG(panels,base.snapshots,base.localizations,base.output_locale,page,true,base.layout.imageCrops);
      const qa=await runNameVisualQA({project:base,pageIds:[page.id],images:[image],imageCapable:true,previous:base.namePlan.qa,ask:args=>askLLM(model,args)});
      if(await nameReadToken(current.current)!==await nameReadToken(base))throw Error('検査中にページが変わりました');
      await commit({...current.current,namePlan:{...current.current.namePlan,qa}});setMessage('AIの指摘を保存しました。内容は自動変更していません。');
    });
  }
  const findings=candidate?.qa?.findings??name?.qa?.findings??[];
  return <section className="name-plan-controls" aria-label="ネームAIと保存ネーム">
    <h4>ネームを設計する</h4>
    {atomResult.error&&<p role="alert">{atomResult.error}</p>}
    <label>演出の指示<textarea aria-label="ネームの演出指示" value={instruction} onChange={e=>setInstruction(e.target.value)} disabled={busy} placeholder="見せ場は大きく、掛け合いは軽快に。最後の表情に一拍。"/></label>
    <details><summary>制作する文章（{selected.length}単位）</summary>
      <button disabled={busy} onClick={()=>setSelection(null)}>選択した場面の全文章</button><button disabled={busy} onClick={()=>setSelection([])}>選択を解除</button>
      <div className="name-atom-list">{atoms.map(atom=><label key={atom.id}><input type="checkbox" checked={selected.includes(atom.id)} disabled={busy} onChange={e=>setSelection(e.target.checked?[...selected,atom.id]:selected.filter(id=>id!==atom.id))}/><span>{atom.kind==='reference'?'［参照・書式］':''}{atom.text}</span></label>)}</div>
    </details>
    <button disabled={busy||!connected||!selected.length} onClick={()=>generate()}>選択原稿からネーム候補を作る</button>
    {!connected&&<small>演出AIの接続を登録すると生成できます。ファイル取込・座標計算にはAI接続は不要です。</small>}
    <button disabled={busy||!snapshot||!episodeId} onClick={readRepositoryPlan}>同じGitHub版のネームを読み込む</button>
    <small><code>{snapshot?.library?.root??snapshot?.sync?.source_root??''}/manga/{episodeId||'<episodeId>'}/name-plan.json</code> を原稿と同じcommitから取得します。取得だけでは採用・作画しません。</small>
    <label>ネームJSONを取り込む<input type="file" aria-label="ネームJSONを取り込む" accept=".json,application/json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';readFile(file);}}/></label>
    {candidates.length>0&&<div><label>保存したネーム候補<select aria-label="保存したネーム候補" disabled={busy} value={job?.id??''} onChange={e=>{setChosen(e.target.value);setPageIndex(0);setPreview(null);}}>{candidates.map(j=><option key={j.id} value={j.id}>{j.nameCandidate?.file.title??'旧形式ネーム'} · {j.nameCandidate?.layout.pages.length??'?'}ページ</option>)}</select></label>
      {candidate&&<p>{candidate.layout.pages.length}ページ／{candidate.panels.length}コマ。掲載文字と絵による対応を分離済み。</p>}
      <button disabled={busy} onClick={()=>adopt()}>このネーム候補を採用</button>{candidate&&<button disabled={busy} onClick={()=>adopt('separate')}>旧稿を残して別初稿に採用</button>}
      <button disabled={busy} onClick={()=>safeRun('候補を取り下げ',()=>commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'abandoned'}:j)}))}>候補を取り下げる</button>
      {candidate&&<details><summary>候補のコマ枠を手修正</summary><LayoutEditor project={displayProject} current={candidateCurrent} commit={async p=>{const base=current.current,j=base.jobs.find(j=>j.id===job.id);if(!j?.nameCandidate)throw Error('候補が変更されました');const updated=await editNameCandidateLayout(base,j.nameCandidate,p.layout);if(current.current!==base)throw Error('候補の編集中に作品が変わりました');await commit({...base,jobs:base.jobs.map(x=>x.id===j.id?{...x,nameCandidate:{...updated,layoutHistory:p.layoutHistory??[],layoutRedo:p.layoutRedo??[]}}:x)});setPreview(null);}} run={run} busy={busy} pageIndex={Math.min(pageIndex,Math.max(0,displayProject.layout.pages.length-1))} setPage={setPageIndex} model={{...model,connectionId:''}} selected={null} onSelect={()=>{}} cancelled={cancelled}/></details>}
      {candidate&&<details><summary>原稿の掲載方針を確認</summary>{candidate.sourcePolicy.map(entry=><p key={entry.atomId}>{entry.atomId} · {entry.presentation} · {entry.reason}</p>)}</details>}
    </div>}
    {name&&<p role="status">{name.status==='stale'?'原稿・参照との再確認が必要':'確定ネーム'} · {name.pageIds.length}ページ／{name.panelIds.length}コマ{name.geometryOverride?' · 手動配置を保持':''}</p>}
    {name?.staleReason&&<p role="alert">{name.staleReason}</p>}
    {pages.length>0&&<div>
      <label>ネームページ<select aria-label="ネームページ" value={Math.min(pageIndex,pages.length-1)} onChange={e=>{setPageIndex(Number(e.target.value));setPreview(null);setEdit(null);}}>{pages.map((p,i)=><option key={p.id} value={i}>{i+1}ページ · {p.slots.length}コマ</option>)}</select></label>
      <button disabled={busy} onClick={proof}>実文字入り仮ネームを確認</button>
      <label>表示幅<select aria-label="ネーム表示幅" value={width} onChange={e=>setWidth(Number(e.target.value))}>{[375,430,1024].map(w=><option key={w} value={w}>{w}px</option>)}</select></label>
      {preview&&<div className="name-proof-scroll"><img src={preview} alt="実際のコマ枠と掲載文字による仮ネーム" style={{width,maxWidth:'none',height:'auto'}}/></div>}
      {name&&!candidate&&page&&<>
        <label><input type="checkbox" aria-label="このネームページを固定" checked={!!name.locks?.pages?.[page.id]} disabled={busy} onChange={e=>safeRun('ページ固定を変更',()=>commit(setNameLock(current.current,page.id,e.target.checked)))}/>このページを固定</label>
        <button disabled={busy||!connected||!instruction.trim()||name.status==='stale'} onClick={()=>safeRun('局所編集案を作成',async()=>setEdit(await proposeNameEdit(current.current,page.id,instruction,(prompt,schema)=>askLLM(model,{purpose:'edit',prompt,schema})) ))}>このページの編集案を作る</button>
        {edit&&<div><p>{edit.reason}（{edit.kind}）</p><button disabled={busy} onClick={()=>edit.kind==='replan'?generate(pageAtomSelection(current.current,edit.pageId),edit.instruction):safeRun('編集案を採用',async()=>{await commit(await applyNameEdit(current.current,edit));setEdit(null);setPreview(null);})}>{edit.kind==='replan'?'再ネーム候補を生成':'編集案を適用'}</button><button onClick={()=>setEdit(null)}>見送る</button></div>}
        <label><input type="checkbox" checked={visionConsent} onChange={e=>setVisionConsent(e.target.checked)} disabled={busy}/>選択ページ画像を設定済み画像対応AIへ送り、指摘だけを受け取る</label>
        <button disabled={busy||!connected||!visionConsent||!model?.visualEditing||name.status==='stale'} onClick={visualQA}>読者視点でページを検査</button>
      </>}
    </div>}
    {findings.length>0&&<details><summary>演出・視覚の注意（{findings.length}件）</summary>{findings.map((finding,i)=><p key={i}>{finding.message??finding.evidence} {finding.suggestion??''}</p>)}</details>}
    <small>取り込みだけでは作画・公開しません。仮ネームの文字溢れは修正が必要です。AIの指摘は面白さや読了率の保証ではありません。</small>
    {message&&<p role="status">{message}</p>}
  </section>;
}
