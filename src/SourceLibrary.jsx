import React, {useState} from 'react';
import {call} from './bridge';
import {availableStoryWorks, DEFAULT_STORY_LIBRARY_REPO, SOURCE_BRANCHES} from './story-library.js';

export default function SourceLibrary({
  library, setLibrary, busy, run, commit, current,
  catalog, selectedWorkId, selectedEpisodeId, selectedSceneId,
  selectedEpisodeIds=[], sourceBranch='main',
  onRefreshCatalog, onSelectWork, onSelectEpisode, onSelectScene,
  onToggleImportEpisode, onSelectAllEpisodes, onSourceBranch, onCheckSource,
}) {
  const [adding,setAdding]=useState(false),[name,setName]=useState(''),[newRepo,setNewRepo]=useState(''),[newEpisode,setNewEpisode]=useState('P01');
  const works=catalog?.catalog ? availableStoryWorks(catalog.catalog, 'manga') : [];
  const outline=catalog?.outline ?? [];
  const selectedEpisode=outline.find(item=>item.id===selectedEpisodeId);
  async function open(id) { await commit(current.current); await call('backup_open',{workspace:id}); }
  return <div>
    <section aria-label="作品の管理">
      <label>制作データを選ぶ
        <select aria-label="登録済み作品" disabled={busy} value={library.active} onChange={e=>run('作品を開き直します',()=>open(e.target.value))}>
          {!library.entries.some(e=>e.id===library.active)&&<option value={library.active}>未接続の作品</option>}
          {library.entries.map(e=><option key={e.id} value={e.id}>{e.name}{e.work_id ? ` · ${e.work_id}` : ` · ${e.repo}`}</option>)}
        </select>
      </label>
      <small>作品の切替時は保存して再起動します。</small>
    </section>
    <section aria-label="原稿ライブラリ">
      <h3>原稿ライブラリ</h3>
      <p>接続先: <code>{DEFAULT_STORY_LIBRARY_REPO}</code>{catalog ? ` · ${catalog.branch??sourceBranch} @ ${catalog.sha.slice(0,8)}` : ''}</p>
      <label>原稿ブランチ
        <select aria-label="原稿ブランチ" disabled={busy} value={sourceBranch} onChange={e=>run('原稿ブランチを変更',()=>onSourceBranch(e.target.value))}>
          {SOURCE_BRANCHES.map(branch=><option key={branch} value={branch}>{branch}</option>)}
        </select>
      </label>
      <button disabled={busy} onClick={()=>run('原稿一覧を更新中',onRefreshCatalog)}>一覧を更新</button>
      {!catalog&&<small>接続・人物設定でトークンを登録してから更新してください。</small>}
      {!!catalog&&<label>作品を選ぶ
        <select aria-label="原稿ライブラリの作品" disabled={busy} value={selectedWorkId||''} onChange={e=>run('作品を読み込み中',()=>onSelectWork(e.target.value))}>
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
      {!!selectedEpisode&&<label>シーンを選ぶ
        <select aria-label="原稿ライブラリのシーン" disabled={busy} value={selectedSceneId||''} onChange={e=>run('シーンを選択中',()=>onSelectScene(e.target.value))}>
          {selectedEpisode.scenes.map(scene=><option key={scene.id} value={scene.id}>{scene.title} · {scene.id}</option>)}
        </select>
      </label>}
      {onCheckSource&&<button className="primary full" disabled={busy} onClick={onCheckSource}>原稿の更新を確認</button>}
      {!!catalog?.work&&<small>{sourceBranch}の差分を確認してから取り込みます。</small>}
    </section>
    <section aria-label="旧形式の作品登録">
      <button disabled={busy} onClick={()=>setAdding(!adding)}>作品を追加</button>
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
    </section>
  </div>;
}
