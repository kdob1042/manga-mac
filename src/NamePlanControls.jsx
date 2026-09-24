import { fetchSourceHead } from './story-library.js';
import { call } from './bridge.js';
import { allNamePlans, nameSourceSnapshot, selectNamePart } from './name-parts.js';
import { stageEmbeddedName } from './name-entry.js';
import CharacterReferences from './CharacterReferences.jsx';
import LayoutEditor from './LayoutEditor.jsx';
import React, { useMemo, useState, useRef } from 'react';
import { atomize, hasEmbeddedSource, namePartKey } from '../contracts/name-plan/source.mjs';
import { MAX_BYTES } from '../contracts/name-plan/schema.mjs';
import { FORMAT, createNameCandidate, adoptNameCandidate, editNameCandidateLayout, setNameLock, nameReadToken } from './name-v2.js';
import { generateNameCandidate, proposeNameEdit, applyNameEdit, pageAtomSelection, runNameVisualQA } from './name-v2-ai.js';
import { importNamePlan } from './name-import.js';
import { askLLM } from './llm.js';
import { fetchRepositoryNamePlan, validateRepositoryNameTarget } from './name-repository.js';
import { pagePNG } from './render.js';
import {runContinuityQA,assertContinuityQACurrent} from './continuity-qa.js';
import {effectiveContinuity,setContinuityOverride} from './continuity.js';

function ContinuityEditor({panel,project,disabled,onSave}) {
  const [draft,setDraft]=useState(()=>({...(effectiveContinuity(panel)??{}),characters:panel.characterIds.map(id=>({id,holding:[],...structuredClone(effectiveContinuity(panel)?.characters?.find(c=>c.id===id)??{})})),props:[...(effectiveContinuity(panel)?.props??[])],hardConstraints:[...(effectiveContinuity(panel)?.hardConstraints??[])]}));
  const split=text=>text.split(/[、,\n]/).map(x=>x.trim()).filter(Boolean);
  const peers=project.panels.slice(0,project.panels.findIndex(p=>p.id===panel.id)).filter(p=>p.sceneId===panel.sceneId);
  const updateCharacter=(id,key,value)=>setDraft(old=>({...old,characters:panel.characterIds.map(characterId=>({...old.characters.find(c=>c.id===characterId),id:characterId,...(characterId===id?{[key]:value}:{})}))}));
  return <div className="continuity-editor"><strong>{panel.id}</strong>
    <label>前コマ参照<select disabled={disabled} value={draft.previousPanelId??''} onChange={e=>setDraft(old=>({...old,previousPanelId:e.target.value||null}))}><option value="">なし</option>{peers.map(p=><option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
    {panel.characterIds.map(id=>{const c=draft.characters.find(c=>c.id===id)??{id};return <div key={id}><strong>{project.characters.find(x=>x.id===id)?.name??id}</strong>
      <label>衣装<input disabled={disabled} maxLength={200} value={c.costume??''} onChange={e=>updateCharacter(id,'costume',e.target.value)}/></label>
      <label>見た目・汗・傷<input disabled={disabled} maxLength={200} value={c.visualState??''} onChange={e=>updateCharacter(id,'visualState',e.target.value)}/></label>
      <label>感情・表情<input disabled={disabled} maxLength={200} value={c.emotion??''} onChange={e=>updateCharacter(id,'emotion',e.target.value)}/></label>
      <label>持ち物<input disabled={disabled} value={(c.holding??[]).join('、')} onChange={e=>updateCharacter(id,'holding',split(e.target.value))}/></label>
    </div>})}
    <label>小道具<input disabled={disabled} value={draft.props.join('、')} onChange={e=>setDraft(old=>({...old,props:split(e.target.value)}))}/></label>
    <label>守る状態（1行に1件）<textarea disabled={disabled} value={draft.hardConstraints.join('\n')} onChange={e=>setDraft(old=>({...old,hardConstraints:e.target.value.split('\n').map(x=>x.trim()).filter(Boolean)}))}/></label>
    <button disabled={disabled} onClick={()=>onSave(draft)}>この状態を固定</button>{panel.continuityOverride&&<button disabled={disabled} onClick={()=>onSave(null)}>固定を解除</button>}
    <small>次の作画・再作画から反映します。既存画像は変更しません。</small>
  </div>;
}

// Reuses the existing draft, Job, renderer, connection and atomic writer boundaries.
export default function NamePlanControls({project,current,commit,run,busy,model,sceneIds,onSwitch,cancelled=()=>false,sourceToken='',episodeId=''}) {
  const [partNumber,setPartNumber]=useState(1);
  const [instruction,setInstruction]=useState(''),[selection,setSelection]=useState(null),[chosen,setChosen]=useState('');
  const [preview,setPreview]=useState(null),[pageIndex,setPageIndex]=useState(0),[width,setWidth]=useState(430);
  const [edit,setEdit]=useState(null),[visionConsent,setVisionConsent]=useState(false),[message,setMessage]=useState('');
  const snapshot=nameSourceSnapshot(project);
  const atomResult=useMemo(()=>{try{return {atoms:snapshot?atomize(snapshot):[],error:''};}catch(error){return {atoms:[],error:error.message};}},[snapshot]);
  const atoms=atomResult.atoms.filter(atom=>!sceneIds?.length||sceneIds.includes(atom.source.sceneId));
  const selected=selection===null?atoms.map(atom=>atom.id):atoms.filter(atom=>selection.includes(atom.id)).map(atom=>atom.id);
  const episodeScenes=new Set((snapshot?.scenes??[]).filter(scene=>!episodeId||scene.episodeId===episodeId).map(scene=>scene.id));
  const candidateMatchesEpisode=job=>hasEmbeddedSource(job.nameCandidate?.file)||!episodeId||job.repositoryPlan?.episodeId===episodeId||job.nameCandidate?.sourcePolicy?.some(entry=>episodeScenes.has(entry.source.sceneId));
  const candidates=project.jobs.filter(job=>job.kind==='name_plan'&&job.status==='candidate'&&(job.nameCandidate||job.legacyNameRaw)&&candidateMatchesEpisode(job));
  const job=candidates.find(job=>job.id===chosen)??candidates.at(-1),candidate=job?.nameCandidate;
  const savedName=project.namePlan?.format===FORMAT?project.namePlan:null;
  const name=savedName&&(hasEmbeddedSource(savedName.file)||savedName.snapshotId===project.active)?savedName:null;
  const nameParts=allNamePlans(project).sort((a,b)=>(a.file.source.episodeId??'').localeCompare(b.file.source.episodeId??'')||(a.file.source.number??0)-(b.file.source.number??0));
  const replacing=candidate&&nameParts.some(state=>namePartKey(state.file)&&namePartKey(state.file)===namePartKey(candidate.file));
  const displayProject=candidate?{...project,panels:candidate.panels,snapshots:candidate.sourceSnapshot&&!project.snapshots.some(s=>s.id===candidate.sourceSnapshot.id)?[...project.snapshots,candidate.sourceSnapshot]:project.snapshots,layout:candidate.layout,layoutHistory:candidate.layoutHistory??[],layoutRedo:candidate.layoutRedo??[]}:project;
  const candidateCurrent=useRef(displayProject);candidateCurrent.current=displayProject;
  const pages=candidate?candidate.layout.pages:name?project.layout.pages.filter(page=>name.pageIds.includes(page.id)):[];
  const page=pages[Math.min(pageIndex,Math.max(0,pages.length-1))];
  const connected=!!model?.connectionId,editConnected=connected;
  const fallbackAvailable=!name&&!candidates.length;
  const safeRun=(label,fn)=>run(label,async()=>{setMessage('');await fn();});
  const clear=()=>{setPreview(null);setEdit(null);onSwitch?.();};
  async function stageRaw(raw,provenance=null) {
    const base=current.current;let data;
    if(typeof raw!=='string'||new TextEncoder().encode(raw).length>MAX_BYTES)throw Error('ネームJSONは4MiB以内で指定してください');
    try{data=JSON.parse(raw);}catch{throw Error('ネームJSONを読み取れません');}
    if(provenance)validateRepositoryNameTarget(base,data,provenance);
    if(hasEmbeddedSource(data)){const next=await stageEmbeddedName(base,raw,provenance);if(current.current!==base)throw Error('取込中に作品が変わりました');await commit(next);setChosen(next.jobs.at(-1).id);setPageIndex(0);const candidate=next.jobs.at(-1).nameCandidate,target=candidate.layout.pages[0];setPreview(await pagePNG(target.slots.map(slot=>candidate.panels.find(panel=>panel.id===slot.panelId)).filter(Boolean),next.snapshots,next.localizations??[],next.output_locale??'ja',target,true,candidate.layout.imageCrops));setMessage('原文入りネームを読み込みました。確認して採用してください。');return;}
    const id=crypto.randomUUID();
    const entry={id,kind:'name_plan',status:'candidate',source_revision:base.active,at:new Date().toISOString(),...(provenance?{repositoryPlan:provenance}:{})};
    if(data?.format===FORMAT)entry.nameCandidate=await createNameCandidate(base,data);
    else {await importNamePlan(base,raw);entry.legacyNameRaw=raw;entry.base=await nameReadToken(base);}
    if(current.current!==base)throw Error('ネーム確認中に作品が変わりました');
    await commit({...base,jobs:[...base.jobs,entry]});setChosen(id);setPageIndex(0);setPreview(null);
    if(entry.nameCandidate?.layout.pages?.[0]){
      const target=entry.nameCandidate.layout.pages[0];
      const panels=target.slots.map(slot=>entry.nameCandidate.panels.find(panel=>panel.id===slot.panelId)).filter(Boolean);
      setPreview(await pagePNG(panels,base.snapshots,base.localizations,base.output_locale,target,true,entry.nameCandidate.layout.imageCrops));
    }
    setMessage(provenance?'同じGitHub版のネームを候補として保存しました。ページを確認して採用してください。':'候補を保存しました。ページを確認して採用してください。');
  }
  async function readFile(file) {
    if(!file)return;
    await safeRun('ネームファイルを検査',async()=>{if(file.size>MAX_BYTES)throw Error('ネームJSONは4MiB以内で指定してください');await stageRaw(await file.text());});
  }
  async function readRepositoryPlan() {
    await safeRun('GitHubのネームを取得',async()=>{
      if(!snapshot)throw Error('原稿を先に取り込んでください');
      const base=current.current, numbered=snapshot.embeddedName;
      const context=numbered?{...snapshot,...await fetchSourceHead(snapshot.repo,sourceToken,call,snapshot.sync?.source_branch??'dev')}:snapshot;
      const fetched=await fetchRepositoryNamePlan(context,episodeId,sourceToken,call,numbered?partNumber:null);
      if(current.current!==base)throw Error('取得中に作品または原稿版が変わりました');
      const {raw,...provenance}=fetched;await stageRaw(raw,provenance);
    });
  }
  async function generate(ids=selected,customInstruction=instruction,{localEdit=false}={}) {
    await safeRun(localEdit?'局所ネーム候補を生成':'ネーム候補を生成',async()=>{
      if(!ids.length)throw Error('制作する文章を選んでください');
      if(localEdit&&!model?.connectionId)throw Error('局所編集に使うAI接続を設定してください');
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
      setPreview(await pagePNG(panels,displayProject.snapshots,project.localizations,project.output_locale,page,true,displayProject.layout.imageCrops));
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
  async function continuityQA(panelId) {
    await safeRun('連続コマの画像を確認',async()=>{
      if(!visionConsent||!model?.visualEditing||candidate)throw Error('画像入力対応と送信内容を確認してください');
      const qa=await runContinuityQA({project:current.current,panelId,imageCapable:true,ask:args=>askLLM(model,args)});
      await assertContinuityQACurrent(current.current,qa);
      await commit({...current.current,namePlan:{...current.current.namePlan,continuityQA:{...(current.current.namePlan.continuityQA??{}),[panelId]:qa}}});
      setMessage('連続コマの見た目を検査しました。指摘だけを保存し、画像は変更していません。');
    });
  }
  const continuityPairs=(page?.slots??[]).map(slot=>project.panels.find(panel=>panel.id===slot.panelId)).filter(panel=>panel?.image&&effectiveContinuity(panel)?.previousPanelId&&project.panels.some(previous=>previous.id===effectiveContinuity(panel).previousPanelId&&previous.image&&previous.sceneId===panel.sceneId));
  const findings=candidate?.qa?.findings??name?.qa?.findings??[];
  return <section className="name-plan-controls" aria-label="ネームAIと保存ネーム">
    {nameParts.length>0&&<label>採用したネーム<select aria-label="採用したネーム" value={name?.id??''} disabled={busy} onChange={e=>safeRun('ネームを選択',async()=>{await commit(selectNamePart(current.current,e.target.value));setPageIndex(0);setPreview(null);setSelection(null);})}>{nameParts.map(state=><option key={state.id} value={state.id}>{state.file.source.episodeId} · ネーム{state.file.source.number??'（旧形式）'} · {state.file.title}</option>)}</select></label>}
    <h4>{name?'ネームを編集':candidates.length?'ネーム候補を確認':'ネームを読み込む'}</h4>
    <CharacterReferences project={project} current={current} commit={commit} run={run} busy={busy}/>
    {atomResult.error&&<p role="alert">{atomResult.error}</p>}
    {snapshot?.embeddedName&&<label>GitHubのネーム番号<input type="number" min="1" max="999999" value={partNumber} onChange={e=>setPartNumber(Number(e.target.value))}/></label>}
    <button className={!name&&!candidates.length?'primary':''} disabled={busy||!snapshot||!episodeId} onClick={readRepositoryPlan}>{snapshot?.embeddedName?'GitHubの番号付きネームを読み込む':'同じGitHub版のネームを読み込む'}</button>
    <small hidden={snapshot?.embeddedName}><code>{snapshot?.library?.root??snapshot?.sync?.source_root??''}/manga/{episodeId||'<episodeId>'}/name-plan.json</code> を原稿と同じcommitから取得します。AI接続は不要で、取得だけでは採用・作画しません。</small>
    <details open><summary>ネームJSONを追加</summary>
      <label>ネームJSON<input type="file" aria-label="ネームJSONを取り込む" accept=".json,application/json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';readFile(file);}}/></label>
    </details>
    {fallbackAvailable&&<details><summary>ネームがない場合の代替生成</summary>
      <p>通常はstory-library / Manga Directorのネームを使います。ここではネームが未作成のときだけ代替案を作れます。</p>
      <label>演出の指示<textarea aria-label="ネームの演出指示" value={instruction} onChange={e=>setInstruction(e.target.value)} disabled={busy} placeholder="見せ場は大きく、掛け合いは軽快に。最後の表情に一拍。"/></label>
      <details><summary>制作する文章（{selected.length}単位）</summary>
        <button disabled={busy} onClick={()=>setSelection(null)}>選択した場面の全文章</button><button disabled={busy} onClick={()=>setSelection([])}>選択を解除</button>
        <div className="name-atom-list">{atoms.map(atom=><label key={atom.id}><input type="checkbox" checked={selected.includes(atom.id)} disabled={busy} onChange={e=>setSelection(e.target.checked?[...selected,atom.id]:selected.filter(id=>id!==atom.id))}/><span>{atom.kind==='reference'?'［参照・書式］':''}{atom.text}</span></label>)}</div>
      </details>
      <button disabled={busy||!connected||!selected.length} onClick={()=>generate()}>代替ネーム候補を作る</button>
      {!connected&&<small>代替生成を使う場合だけ演出AIの接続が必要です。GitHubネームの取込・座標計算・手動編集には不要です。</small>}
    </details>}
    {candidates.length>0&&<div><label>保存したネーム候補<select aria-label="保存したネーム候補" disabled={busy} value={job?.id??''} onChange={e=>{setChosen(e.target.value);setPageIndex(0);setPreview(null);}}>{candidates.map(j=><option key={j.id} value={j.id}>{j.nameCandidate?.file.title??'旧形式ネーム'} · {j.nameCandidate?.layout.pages.length??'?'}ページ</option>)}</select></label>
      {candidate&&<p>{candidate.layout.pages.length}ページ／{candidate.panels.length}コマ。掲載文字と絵による対応を分離済み。</p>}
      <button disabled={busy} onClick={()=>adopt(replacing?'replace-part':'replace')}>{replacing?'この番号を更新':'このネーム候補を採用'}</button>{candidate&&!hasEmbeddedSource(candidate.file)&&<button disabled={busy} onClick={()=>adopt('separate')}>旧稿を残して別初稿に採用</button>}
      <button disabled={busy} onClick={()=>safeRun('候補を取り下げ',()=>commit({...current.current,jobs:current.current.jobs.map(j=>j.id===job.id?{...j,status:'abandoned'}:j)}))}>候補を取り下げる</button>
      {candidate&&<details><summary>候補のコマ枠を手修正</summary><LayoutEditor project={displayProject} current={candidateCurrent} commit={async p=>{const base=current.current,j=base.jobs.find(j=>j.id===job.id);if(!j?.nameCandidate)throw Error('候補が変更されました');const updated=await editNameCandidateLayout(base,j.nameCandidate,p.layout);if(current.current!==base)throw Error('候補の編集中に作品が変わりました');await commit({...base,jobs:base.jobs.map(x=>x.id===j.id?{...x,nameCandidate:{...updated,layoutHistory:p.layoutHistory??[],layoutRedo:p.layoutRedo??[]}}:x)});setPreview(null);}} run={run} busy={busy} pageIndex={Math.min(pageIndex,Math.max(0,displayProject.layout.pages.length-1))} setPage={setPageIndex} model={{...model,connectionId:''}} selected={null} onSelect={()=>{}} cancelled={cancelled}/></details>}
      {candidate&&<details><summary>原稿の掲載方針を確認</summary>{candidate.sourcePolicy.map(entry=><p key={entry.atomId}>{entry.atomId} · {entry.presentation} · {entry.reason}</p>)}</details>}
    </div>}
    {name&&<p role="status">{name.status==='stale'?'原稿・参照との再確認が必要':'確定ネーム'} · {name.pageIds.length}ページ／{name.panelIds.length}コマ{name.geometryOverride?' · 手動配置を保持':''}</p>}
    {name?.staleReason&&<p role="alert">{name.staleReason}</p>}
    {pages.length>0&&<div>
      <label>ネームページ<select aria-label="ネームページ" value={Math.min(pageIndex,pages.length-1)} onChange={e=>{setPageIndex(Number(e.target.value));setPreview(null);setEdit(null);}}>{pages.map((p,i)=><option key={p.id} value={i}>{i+1}ページ · {p.slots.length}コマ</option>)}</select></label>
      <button disabled={busy} onClick={proof}>{preview?'プレビューを更新':'実文字入り仮ネームを確認'}</button>
      <label>表示幅<select aria-label="ネーム表示幅" value={width} onChange={e=>setWidth(Number(e.target.value))}>{[375,430,1024].map(w=><option key={w} value={w}>{w}px</option>)}</select></label>
      {preview&&<div className="name-proof-scroll"><img src={preview} alt="実際のコマ枠と掲載文字による仮ネーム" style={{width,maxWidth:'none',height:'auto'}}/></div>}
      {name&&!candidate&&page&&<>
        <details><summary>コマの衣装・持ち物・表情を固定</summary>{page.slots.map(slot=>project.panels.find(p=>p.id===slot.panelId)).filter(Boolean).map(panel=><ContinuityEditor key={`${panel.id}:${JSON.stringify(panel.continuityOverride??null)}`} panel={panel} project={project} disabled={busy||name.status==='stale'} onSave={value=>safeRun('作画状態を固定',()=>commit(setContinuityOverride(current.current,panel.id,value)))}/>)}</details>
        <label><input type="checkbox" aria-label="このネームページを固定" checked={!!name.locks?.pages?.[page.id]} disabled={busy} onChange={e=>safeRun('ページ固定を変更',()=>commit(setNameLock(current.current,page.id,e.target.checked)))}/>このページを固定</label>
        <label>このページの修正指示<textarea aria-label="ネームの局所修正指示" value={instruction} onChange={e=>setInstruction(e.target.value)} disabled={busy} placeholder="3コマ目を大きく／右上を2分割／このページだけ再配置"/></label>
        <small>{editConnected?'設定済みAIで現在ページだけを解釈します。OllamaでもクラウドAIでも利用できます。':'AI未接続でも手動編集とネーム取込は使えます。'}</small>
        <button disabled={busy||!editConnected||!instruction.trim()||name.status==='stale'} onClick={()=>safeRun('局所編集案を作成',async()=>setEdit(await proposeNameEdit(current.current,page.id,instruction,(prompt,schema)=>askLLM(model,{purpose:'edit',prompt,schema})) ))}>AIで修正案を作る</button>
        {edit&&<div><p>{edit.reason}（{edit.kind}）</p><button disabled={busy} onClick={()=>edit.kind==='replan'?generate(pageAtomSelection(current.current,edit.pageId),edit.instruction,{localEdit:true}):safeRun('編集案を採用',async()=>{await commit(await applyNameEdit(current.current,edit));setEdit(null);setPreview(null);})}>{edit.kind==='replan'?'このページだけ再構成':'編集案を適用'}</button><button onClick={()=>setEdit(null)}>見送る</button></div>}
        <label><input type="checkbox" checked={visionConsent} onChange={e=>setVisionConsent(e.target.checked)} disabled={busy}/>選択ページまたは連続コマ画像を設定済み画像対応AIへ送り、指摘だけを受け取る</label>
        <button disabled={busy||!connected||!visionConsent||!model?.visualEditing||name.status==='stale'} onClick={visualQA}>読者視点でページを検査</button>
        {continuityPairs.length>0&&<details><summary>連続コマの見た目を確認</summary>{continuityPairs.map(panel=>{
          const qa=name.continuityQA?.[panel.id],previous=project.panels.find(p=>p.id===effectiveContinuity(panel).previousPanelId);
          const currentQA=qa&&qa.panelRevision===(panel.artwork_revision??null)&&qa.previousRevision===(previous?.artwork_revision??null)&&qa.base;
          return <div key={panel.id}><button disabled={busy||!connected||!visionConsent||!model?.visualEditing||name.status==='stale'} onClick={()=>continuityQA(panel.id)}>{panel.id} の前後画像を検査</button>{currentQA&&<small>指摘 {qa.findings.length}件 · 未承認</small>}{currentQA&&qa.findings.map((finding,i)=><p key={i}>{finding.severity}: {finding.evidence} → {finding.suggestion}</p>)}</div>;
        })}</details>}
      </>}
    </div>}
    {findings.length>0&&<details><summary>演出・視覚の注意（{findings.length}件）</summary>{findings.map((finding,i)=><p key={i}>{finding.message??finding.evidence} {finding.suggestion??''}</p>)}</details>}
    <small>取り込みだけでは作画・公開しません。仮ネームの文字溢れは修正が必要です。AIの指摘は面白さや読了率の保証ではありません。</small>
    {message&&<p role="status">{message}</p>}
  </section>;
}
