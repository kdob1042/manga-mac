import React, {useState} from 'react';
import { PAGE_FORMAT, affectedByAppearance, editPageList, editNamePage, joinEpisodeFiles, splitEpisodeFiles } from '../contracts/name-plan/page.mjs';
import { adoptNamePages, adoptRepositoryNamePages, commitNameEpisode, editProjectNamePage, editProjectNameScene, restoreProjectNameRevision, saveNameRevision, episodeKey, referenceKey, registerNameReference } from './page-name.js';
import {fetchPageNameIndex,fetchSelectedPageNames,fetchPageNameReferences} from './name-repository.js';
import {proposePageEdit} from './page-name-ai.js';
import {askLLM} from './llm.js';
import CharacterReferences from './CharacterReferences.jsx';
import {migrateSavedName} from './page-name-legacy.js';

const identity = project => episodeKey(project.workId, project.activeNameEpisodeId);
const download = (name, value) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
};
export default function PageNameControls({project,current,commit,run,busy,onAdopt,token='',model=null}) {
  const [candidate,setCandidate]=useState(null),[chosen,setChosen]=useState([]),[positions,setPositions]=useState({});
  const [candidateReferences,setCandidateReferences]=useState(null);
  const [selectedPage,setSelectedPage]=useState(''),[revision,setRevision]=useState('');
  const [notice,setNotice]=useState('');
  const [instruction,setInstruction]=useState(''),[proposal,setProposal]=useState(null);
  const [newSceneLabel,setNewSceneLabel]=useState(''),[newAppearance,setNewAppearance]=useState(''),[newAppearancePerson,setNewAppearancePerson]=useState('');
  const [remote,setRemote]=useState(null),[remotePages,setRemotePages]=useState([]);
  const [repository,setRepository]=useState('kdob1042/story-library'),[workRoot,setWorkRoot]=useState(project.workId?`works/${project.workId}`:''),[episodeId,setEpisodeId]=useState(project.activeNameEpisodeId??project.namePlan?.file?.source?.episodeId??'P01');
  const active=project.nameEpisodes?.[identity(project)];
  const pageId=active?.pageIds.includes(selectedPage)?selectedPage:active?.pageIds[0];
  const page=active?.pages.find(p=>p.id===pageId);
  const revisions=project.nameRevisions?.[identity(project)]??[];
  const optionalReferences=active?.scenes.flatMap(scene=>[...(scene.backgroundReferenceKey?[{key:scene.backgroundReferenceKey,role:'background',label:`${scene.label??scene.id}の背景`}]:[]),...(scene.appearances??[]).filter(item=>item.referenceKey).map(item=>({key:item.referenceKey,role:'costume',label:`${item.characterId}の衣装 ${item.label}`}))])??[];
  const pending=fn=>run('ページネームを保存中',async()=>{await fn();setNotice('保存しました');});
  async function readFiles(files) {
    if(!files?.length)return;
    const content={};
    for(const file of files){
      if(file.size>4*1024*1024)throw Error(`${file.name} は4MiB以内にしてください`);
      if(content[file.name])throw Error('同じファイル名があります');
      content[file.name]=JSON.parse(await file.text());
    }
    let incoming;
    if(content['episode.json']) {
      const manifest=content['episode.json'],pages={};
      if(manifest.format!==PAGE_FORMAT)throw Error('episode.jsonはページネームv3で指定してください');
      for(const id of manifest.pageIds)if(content[`${id}.json`])pages[id]=content[`${id}.json`];
      incoming=joinEpisodeFiles(manifest,pages);
    } else if(files.length===1) {
      const raw=content[files[0].name];
      if(raw.manifest?.format!==PAGE_FORMAT)throw Error('episode.jsonと選択ページのJSONを一緒に指定してください');
      incoming=joinEpisodeFiles(raw.manifest,raw.pages);
    } else throw Error('episode.jsonを選んでください');
    if(!incoming.pageIds.length)throw Error('選択したページファイルがありません');
    const base=current.current;
    if(base.workId && incoming.workId!==base.workId)throw Error('別作品のページは取り込めません');
    if(current.current!==base)throw Error('読み込み中に作品が変わりました');
    setCandidateReferences(null);setCandidate(incoming);setChosen([...incoming.pageIds]);setPositions({});setNotice('採用するページと、追加ページの位置を確認してください');
  }
  const target=candidate&&project.nameEpisodes?.[episodeKey(candidate.workId, candidate.episodeId)];
  const change=(panelId,operation)=>pending(()=>commit(editProjectNamePage(current.current,active.episodeId,pageId,[{panelId,...operation}])));
  function exportEpisode(){
    if(!active)return;
    const {manifest,pages}=splitEpisodeFiles(active);
    download('episode.json',manifest);
    for(const id of active.pageIds)download(`${id}.json`,pages[id]);
  }
  return <section className="name-plan-controls" aria-label="ページのネーム">
    <h3>ページのネーム</h3>
    {!active&&project.namePlan?.format==='manga-mac/name-plan/v2'&&project.panels.length>0&&<div><p>保存済みの手修正・コマID・画像を保持してページネームへ移します。所属が曖昧な未配置コマは先にページを指定してください。</p><button disabled={busy} onClick={()=>pending(()=>commit(migrateSavedName(current.current,episodeId)))}>現在の編集状態から話 {episodeId} を移行</button></div>}
    <CharacterReferences project={project} current={current} commit={commit} run={run} busy={busy}/>
    <details><summary>GitHubからページを取得</summary>
      <label>リポジトリ<input value={repository} onChange={e=>setRepository(e.target.value)}/></label>
      <label>作品root<input value={workRoot} onChange={e=>setWorkRoot(e.target.value)} placeholder="works/作品ID"/></label>
      <label>話ID<input value={episodeId} onChange={e=>setEpisodeId(e.target.value)}/></label>
      <button disabled={busy} onClick={()=>run('GitHubの話索引を取得中',async()=>{const index=await fetchPageNameIndex({repo:repository,root:workRoot,episodeId},token);setRemote(index);setRemotePages([]);setNotice(`${index.sha.slice(0,8)} の話索引を取得しました`);})}>ページ一覧を取得</button>
      {remote&&<><p>{remote.sha.slice(0,8)} · {remote.manifest.pageIds.length}ページ。取得するページを選んでください。</p>{remote.manifest.pageIds.map(id=><label key={id}><input type="checkbox" checked={remotePages.includes(id)} onChange={e=>setRemotePages(previous=>e.target.checked?[...previous,id]:previous.filter(value=>value!==id))}/>{id}</label>)}
        <button disabled={busy||!remotePages.length} onClick={()=>run('選択ページ・人物参照を取得中',async()=>{const loaded=await fetchSelectedPageNames(remote,remotePages,token);const references=await fetchPageNameReferences(remote,loaded,token);setCandidateReferences(references);setCandidate(loaded);setChosen([...loaded.pageIds]);setPositions({});setNotice(`採用するページを確認してください。人物参照${references.references.length}件も同じ版から取得しました`);})}>選択ページを読み込む</button></>}
    </details>
    <label>episode.json と対象ページのJSONを選ぶ<input type="file" multiple accept=".json,application/json" disabled={busy} onChange={e=>{const files=[...e.target.files];e.target.value='';run('ページネームを読み込み中',()=>readFiles(files));}}/></label>
    {candidate&&<div><h4>取込み候補 · {candidate.episodeId}</h4>
      {candidate.pageIds.map(id=>{const incoming=candidate.pages.find(page=>page.id===id),previous=target?.pages.find(page=>page.id===id);return <div key={id}>
        <label><input type="checkbox" checked={chosen.includes(id)} onChange={e=>setChosen(items=>e.target.checked?[...items,id]:items.filter(x=>x!==id))}/>{id} · {incoming.panels.length}コマ · {previous?`現在 ${previous.panels.length}コマから置換`:'新規ページ'}</label>
        {previous&&<small>現在: {previous.purpose||'目的未設定'} ／ 候補: {incoming.purpose||'目的未設定'}</small>}
        {!previous&&target&&<label>挿入位置（0が先頭）<input type="number" min="0" max={target.pageIds.length} value={positions[id]??target.pageIds.length} onChange={e=>setPositions(old=>({...old,[id]:Number(e.target.value)}))}/></label>}
      </div>})}
      <p>選択しないページは保持します。既存の共通設定は維持し、足りないIDだけ追加します。</p>
      <button disabled={busy||!chosen.length} onClick={()=>pending(async()=>{
        const before=current.current,newIds=candidate.pageIds.filter(id=>chosen.includes(id)&&!target?.pageIds.includes(id));
        const positionsFor=Object.fromEntries(newIds.map((id,i)=>[id,positions[id]??(target?.pageIds.length??0)+i]));
        const selected=candidate.pageIds.filter(id=>chosen.includes(id));
        const next=candidateReferences?adoptRepositoryNamePages(before,candidate,selected,candidateReferences,{positions:positionsFor}):adoptNamePages(before,candidate,selected,{positions:positionsFor});await commit(next);setCandidate(null);setCandidateReferences(null);onAdopt?.();
      })}>選択ページを採用</button><button onClick={()=>setCandidate(null)}>見送る</button>
    </div>}
    {active&&<>
      <p>{active.episodeId} · {active.pageIds.length}ページ。原稿はページ内の原文を使用します。</p>
      {!!optionalReferences.length&&<details><summary>衣装・背景の任意参照画像</summary>{optionalReferences.map(item=>{
        const saved=project.nameReferences?.[referenceKey(active.workId,active.episodeId,item.key,item.role)];
        return <label key={`${item.role}:${item.key}`}>{item.label} · {item.key} · {saved?'登録済み':'文章指定で作画可能'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;run('参照画像を登録中',async()=>{if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>20*1024*1024)throw Error('20MB以下の画像を選んでください');const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});await commit(await registerNameReference(current.current,active.episodeId,item.key,item.role,image));});}}/></label>;
      })}</details>}
      <label>ページ<select value={pageId??''} onChange={e=>setSelectedPage(e.target.value)}>{active.pageIds.map((id,i)=><option key={id} value={id}>{i+1}ページ · {id}</option>)}</select></label>
      <button disabled={busy} onClick={exportEpisode}>話と各ページを書き出す</button>
      <button disabled={busy} onClick={()=>pending(()=>commit(saveNameRevision(current.current,active.episodeId)))}>話の版を保存</button>
      {!!revisions.length&&<label>保存版<select value={revision} onChange={e=>setRevision(e.target.value)}><option value="">復元する版を選ぶ</option>{revisions.map(item=><option key={item.id} value={item.id}>{item.at} · {item.reason} · {item.episode.pageIds.length}ページ</option>)}</select></label>}
      {revision&&<button disabled={busy} onClick={()=>pending(async()=>{await commit(restoreProjectNameRevision(current.current,active.episodeId,revision));setRevision('');})}>選んだ話全体の版を復元</button>}
      <details><summary>話のシーン・衣装を編集</summary>
        <p>共通設定の変更は、このシーン・衣装を使う全コマに反映されます。変更前の話は版へ保存します。</p>
        {active.scenes.map(scene=><details key={scene.id}><summary>{scene.label??scene.id} · {scene.id}</summary>
          {[['label','シーン名'],['location','場所'],['timeOfDay','時刻'],['spatial','空間の説明'],['backgroundReferenceKey','背景画像のキー']].map(([field,label])=><label key={field}>{label}<input key={`${scene.id}:${field}:${scene[field]??''}`} defaultValue={scene[field]??''} onBlur={e=>{if(e.target.value===(scene[field]??''))return;pending(()=>commit(editProjectNameScene(current.current,active.episodeId,scene.id,[{type:'updateScene',changes:{[field]:e.target.value}}])));}}/></label>)}
          {scene.appearances.map(appearance=>{const affected=affectedByAppearance(active,scene.id,appearance.id);return <div key={appearance.id}><strong>{appearance.label??appearance.id} · {appearance.characterId}</strong><small> 使用先: {affected.map(item=>`${item.pageNumber}ページ ${item.panelId}`).join('、')||'なし'}</small>
            {[['label','衣装名'],['costume','服装'],['visualState','外見'],['referenceKey','衣装画像のキー']].map(([field,label])=><label key={field}>{label}<input key={`${appearance.id}:${field}:${appearance[field]??''}`} defaultValue={appearance[field]??''} onBlur={e=>{if(e.target.value===(appearance[field]??''))return;pending(()=>commit(editProjectNameScene(current.current,active.episodeId,scene.id,[{type:'updateAppearance',appearanceId:appearance.id,changes:{[field]:e.target.value}}])));}}/></label>)}
            <button disabled={busy} onClick={()=>pending(()=>commit(editProjectNameScene(current.current,active.episodeId,scene.id,[{type:'removeAppearance',appearanceId:appearance.id}]))) }>この衣装を削除（使用先は未指定に）</button></div>})}
          <label>人物<select value={newAppearancePerson} onChange={e=>setNewAppearancePerson(e.target.value)}><option value="">選択</option>{active.characters.map(person=><option key={person.id} value={person.id}>{person.name??person.id}</option>)}</select></label>
          <label>追加する衣装<input value={newAppearance} onChange={e=>setNewAppearance(e.target.value)}/></label>
          <button disabled={busy||!newAppearancePerson||!newAppearance.trim()} onClick={()=>pending(async()=>{await commit(editProjectNameScene(current.current,active.episodeId,scene.id,[{type:'addAppearance',appearance:{id:crypto.randomUUID(),characterId:newAppearancePerson,label:newAppearance.trim(),costume:newAppearance.trim(),visualState:''}}]));setNewAppearance('');})}>衣装を追加</button>
        </details>)}
        <label>追加するシーン<input value={newSceneLabel} onChange={e=>setNewSceneLabel(e.target.value)}/></label>
        <button disabled={busy||!newSceneLabel.trim()} onClick={()=>pending(async()=>{const id=crypto.randomUUID();await commit(editProjectNameScene(current.current,active.episodeId,id,[{type:'createScene',scene:{id,label:newSceneLabel.trim(),location:'',timeOfDay:'',props:[],spatial:'',hardConstraints:[],appearances:[]}}]));setNewSceneLabel('');})}>シーンを追加</button>
      </details>
      {page&&<>
        <p>このページのコマを編集します。追加・削除しても他のページは動きません。</p>
        <label>このページのAI修正指示<textarea value={instruction} onChange={e=>setInstruction(e.target.value)}/></label>
        <button disabled={busy||!model?.connectionId||!instruction.trim()} onClick={()=>run('ページ修正案を作成中',async()=>setProposal(await proposePageEdit(active,pageId,instruction,(prompt,schema)=>askLLM(model,{purpose:'edit',prompt,schema}))))}>AIでページ修正案を作る</button>
        {proposal?.pageId===pageId&&<div><p>{proposal.reason}</p><p>現在 {proposal.basePage.panels.length}コマ → 候補 {proposal.afterPage.panels.length}コマ。対象: {proposal.operations.map(op=>op.panelId??op.type).join('、')}</p>
          <button disabled={busy} onClick={()=>pending(async()=>{const base=current.current,old=base.nameEpisodes?.[episodeKey(active.workId,active.episodeId)];if(JSON.stringify(old?.pages.find(p=>p.id===pageId))!==JSON.stringify(proposal.basePage))throw Error('候補の作成後に対象ページが変わりました。差分を見直してください');await commit(commitNameEpisode(base,editNamePage(old,pageId,proposal.operations),'AI修正案の採用'));setProposal(null);})}>修正案を採用</button><button onClick={()=>setProposal(null)}>見送る</button></div>}
        <label>ページの目的<input defaultValue={page.purpose??''} key={`${page.id}:${page.purpose??''}`} onBlur={e=>{if(e.target.value===page.purpose)return;pending(()=>{const next=structuredClone(active);next.pages.find(p=>p.id===pageId).purpose=e.target.value;return commit(commitNameEpisode(current.current,next,'ページ意図変更',{saveRevision:false}));});}}/></label>
        {page.sourceExcerpts.map(item=><p key={item.id}><small>当時の原文 · {item.id}</small><br/>{item.text}</p>)}
        {page.panels.map((panel,i)=><details key={panel.id}><summary>{i+1}コマ · {panel.id} · {panel.frame?'配置済み':'未配置'}</summary>
          <label>描写<textarea defaultValue={panel.prompt??''} key={`${panel.id}:${panel.prompt}`} onBlur={e=>{if(e.target.value!==panel.prompt)change(panel.id,{type:'updatePanel',changes:{prompt:e.target.value}});}}/></label>
          <label>シーン<select value={panel.sceneId??''} onChange={e=>change(panel.id,{type:'updatePanel',changes:{sceneId:e.target.value||null,characters:panel.characters.map(c=>({...c,appearanceId:null}))}})}><option value="">未指定</option>{active.scenes.map(scene=><option key={scene.id} value={scene.id}>{scene.label??scene.id}</option>)}</select></label>
          {panel.characters.map(person=>{const scene=active.scenes.find(item=>item.id===panel.sceneId);return <div key={person.characterId}><strong>{active.characters.find(item=>item.id===person.characterId)?.name??person.characterId}</strong>
            <label>衣装<select value={person.appearanceId??''} onChange={e=>change(panel.id,{type:'updatePanel',changes:{characters:panel.characters.map(item=>item.characterId===person.characterId?{...item,appearanceId:e.target.value||null}:item)}})}><option value="">未指定</option>{scene?.appearances.filter(item=>item.characterId===person.characterId).map(item=><option key={item.id} value={item.id}>{item.label??item.id}</option>)}</select></label>
            <button disabled={busy} onClick={()=>change(panel.id,{type:'updatePanel',changes:{characters:panel.characters.filter(item=>item.characterId!==person.characterId)}})}>この人物を外す</button></div>})}
          <label>人物を追加<select value="" onChange={e=>{if(!e.target.value)return;change(panel.id,{type:'updatePanel',changes:{characters:[...panel.characters,{characterId:e.target.value,appearanceId:null,visualState:'',emotion:'',holding:[]}]}})}}><option value="">選択</option>{active.characters.filter(person=>!panel.characters.some(item=>item.characterId===person.id)).map(person=><option key={person.id} value={person.id}>{person.name??person.id}</option>)}</select></label>
          {panel.texts.map(entry=><label key={entry.id}>{entry.kind} · {entry.id}<textarea defaultValue={entry.text} key={`${entry.id}:${entry.text}`} onBlur={e=>{if(e.target.value!==entry.text)change(panel.id,{type:'updateText',textId:entry.id,changes:{text:e.target.value}});}}/><button disabled={busy} onClick={()=>change(panel.id,{type:'removeText',textId:entry.id})}>台詞を削除</button></label>)}
          <button disabled={busy} onClick={()=>change(panel.id,{type:'insertText',index:panel.texts.length,text:{id:crypto.randomUUID(),kind:'dialogue',speakerId:null,text:'',box:null}})}>台詞を追加</button>
          <button disabled={busy} onClick={()=>change(panel.id,{type:'removePanel'})}>このコマを削除</button>
          <button disabled={busy||page.panels.length>=16} onClick={()=>change(panel.id,{type:'splitPanel',moveTextIds:[]})}>このコマを分割（枠未配置）</button>
          {i>0&&<button disabled={busy} onClick={()=>pending(()=>commit(editProjectNamePage(current.current,active.episodeId,pageId,[{type:'reorderPanels',panelIds:page.panels.map(item=>item.id).map((id,at,list)=>at===i-1?list[i]:at===i?list[i-1]:id)}]))) }>前のコマと入れ替え</button>}
          {i>0&&<button disabled={busy} onClick={()=>change(page.panels[i-1].id,{type:'mergePanels',otherPanelIds:[panel.id]})}>前のコマへ統合</button>}
        </details>)}
        <button disabled={busy||page.panels.length>=16} onClick={()=>pending(()=>commit(editProjectNamePage(current.current,active.episodeId,pageId,[{type:'insertPanel',index:page.panels.length,panel:{id:crypto.randomUUID(),sceneId:null,sourceExcerptIds:[],contextExcerptIds:[],beatIds:[],characters:[],texts:[],prompt:'',shotIntent:'',frame:null}}])))}>このページにコマを追加</button>
        <button disabled={busy} onClick={()=>pending(()=>{const next=editPageList(active,{type:'addPage',index:active.pageIds.indexOf(pageId)+1,page:{id:crypto.randomUUID(),purpose:'',sourceExcerpts:[],contextExcerpts:[],panels:[],boundaryContext:{before:null,after:null}}});return commit(commitNameEpisode(current.current,next,'ページ追加'));})}>次に空ページを追加</button>
        <button disabled={busy} onClick={()=>pending(()=>commit(commitNameEpisode(current.current,editPageList(active,{type:'removePage',pageId}),'ページ削除')))}>このページを削除</button>
        {active.pageIds.indexOf(pageId)>0&&<button disabled={busy} onClick={()=>pending(()=>{const ids=[...active.pageIds],i=ids.indexOf(pageId);[ids[i-1],ids[i]]=[ids[i],ids[i-1]];return commit(commitNameEpisode(current.current,editPageList(active,{type:'reorderPages',pageIds:ids}),'ページ順変更'));})}>このページを前へ移動</button>}
      </>}
    </>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
