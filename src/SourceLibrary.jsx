import React, {useState} from 'react';
import {call} from './bridge';
import {availableStoryWorks, DEFAULT_STORY_LIBRARY_REPO, SOURCE_BRANCHES} from './story-library.js';

export default function SourceLibrary({
  library, setLibrary, busy, run, commit, current,
  catalog, selectedWorkId, selectedEpisodeId, selectedSceneId,
  selectedEpisodeIds=[], sourceBranch='main',
  onRefreshCatalog, onSelectWork, onSelectEpisode, onSelectScene,
  onToggleImportEpisode, onSelectAllEpisodes, onSourceBranch, onConfirmImport,
}) {
  const [adding,setAdding]=useState(false),[name,setName]=useState(''),[newRepo,setNewRepo]=useState(''),[newEpisode,setNewEpisode]=useState('P01');
  const works=catalog?.catalog ? availableStoryWorks(catalog.catalog, 'manga') : [];
  const outline=catalog?.outline ?? [];
  const selectedEpisode=outline.find(item=>item.id===selectedEpisodeId);
  return <div className="source-library-form">
    <section aria-label="原稿ライブラリ">
      <h3>原稿ライブラリ</h3>
      <p>接続先: <code>{DEFAULT_STORY_LIBRARY_REPO}</code>{catalog ? ` · 確認済み ${catalog.branch??sourceBranch} @ ${catalog.sha.slice(0,8)} · ${catalog.transport==='local'?'ローカル Git':'GitHub API'}` : ''}</p>
      <label>原稿ブランチ
        <select aria-label="原稿ブランチ" disabled={busy} value={sourceBranch} onChange={e=>run('原稿ブランチを変更',()=>onSourceBranch(e.target.value),'原稿ブランチの取得')}>
          {SOURCE_BRANCHES.map(branch=><option key={branch} value={branch}>{branch}</option>)}
        </select>
      </label>
      {!catalog&&<button disabled={busy} onClick={()=>run('原稿一覧を読み込み中',onRefreshCatalog,'原稿カタログの取得')}>原稿一覧を再試行</button>}
      {!!catalog&&<label>作品を選ぶ
        <select aria-label="原稿ライブラリの作品" disabled={busy} value={selectedWorkId||''} onChange={e=>run('作品を読み込み中',()=>onSelectWork(e.target.value),'作品・話の取得')}>
          <option value="" disabled>作品を選択</option>
          {works.map(work=><option key={work.id} value={work.id}>{work.title} · {work.id}</option>)}
        </select>
      </label>}
      {!!catalog?.work&&<label>閲覧する話
        <select aria-label="話を選ぶ" disabled={busy} value={selectedEpisodeId||''} onChange={e=>run('話を選択中',()=>onSelectEpisode(e.target.value))}>
          {outline.map(item=><option key={item.id} value={item.id}>{item.chapterTitle ? `${item.chapterTitle} / ${item.title}` : item.title} · {item.id}</option>)}
        </select>
      </label>}
      {!!catalog?.work&&<fieldset disabled={busy} aria-label="取り込む話">
        <legend>取り込む話</legend>
        {outline.map(item=><label key={item.id}><input type="checkbox" checked={selectedEpisodeIds.includes(item.id)} onChange={e=>onToggleImportEpisode(item.id,e.target.checked)}/>{item.chapterTitle ? `${item.chapterTitle} / ${item.title}` : item.title}</label>)}
        <button type="button" onClick={()=>onSelectAllEpisodes(false)}>閲覧中だけ</button>
        <button type="button" onClick={()=>onSelectAllEpisodes(true)}>全話</button>
        <small>次回の取込対象: {selectedEpisodeIds.length}話</small>
      </fieldset>}
      {!!selectedEpisode&&<label>閲覧するシーン
        <select aria-label="原稿ライブラリのシーン" disabled={busy} value={selectedSceneId||''} onChange={e=>run('シーンを選択中',()=>onSelectScene(e.target.value))}>
          {selectedEpisode.scenes.map(scene=><option key={scene.id} value={scene.id}>{scene.title} · {scene.id}</option>)}
        </select>
      </label>}
      <button className="primary full" disabled={busy||!catalog?.work||!selectedEpisodeIds.length} onClick={onConfirmImport}>変更を確認</button>
      {!!catalog?.work&&<small>{sourceBranch}の差分を表示します。確認後に取り込むまで制作中の原稿は変わりません。</small>}
    </section>
    <details aria-label="旧形式の作品登録"><summary>旧形式の原稿を登録</summary><section>
      <button disabled={busy} onClick={()=>setAdding(!adding)}>独立したリポジトリを追加</button>
      {adding&&<div>
        <label>作品表示名<input value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>追加するGitHubリポジトリ<input value={newRepo} onChange={e=>setNewRepo(e.target.value)} placeholder="owner/repository"/></label>
        <label>最初の話ID<input value={newEpisode} onChange={e=>setNewEpisode(e.target.value)}/></label>
        <small>独立したリポジトリの原稿を登録します。</small>
        <button disabled={busy||!name.trim()||!newRepo.trim()||!newEpisode.trim()} onClick={()=>run('作品を登録中',async()=>{
          const result=await call('source_register',{name:name.trim(),repo:newRepo.trim(),episode:newEpisode.trim(),id:null});
          setLibrary({...library,entries:result.entries,active:result.id});setAdding(false);setName('');setNewRepo('');setNewEpisode('P01');
        })}>登録する</button>
      </div>}
    </section></details>
  </div>;
}
