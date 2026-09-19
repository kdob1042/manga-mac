import React, {useState} from 'react';
import {call} from './bridge';
import {availableStoryWorks, DEFAULT_STORY_LIBRARY_REPO} from './story-library.js';

export default function SourceLibrary({
  library, setLibrary, busy, run, commit, current,
  catalog, selectedWorkId, selectedEpisodeId, selectedSceneId,
  onRefreshCatalog, onSelectWork, onSelectEpisode, onSelectScene,
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
      <small>切替時にアプリを再起動します。原稿・画像・履歴は作品ごとに分離され、接続トークンは再入力してください。</small>
    </section>
    <section aria-label="原稿ライブラリ">
      <h3>原稿ライブラリ</h3>
      <p>接続先: <code>{DEFAULT_STORY_LIBRARY_REPO}</code>{catalog ? ` · catalog @ ${catalog.sha.slice(0,8)}` : ''}</p>
      <button disabled={busy} onClick={()=>run('原稿一覧を更新中',onRefreshCatalog)}>一覧を更新</button>
      {!catalog&&<small>「制作の準備」で読み取り専用トークンを設定してから更新します。接続先は固定です。</small>}
      {!!catalog&&<label>作品を選ぶ
        <select aria-label="原稿ライブラリの作品" disabled={busy} value={selectedWorkId||''} onChange={e=>run('作品を読み込み中',()=>onSelectWork(e.target.value))}>
          <option value="" disabled>作品を選択</option>
          {works.map(work=><option key={work.id} value={work.id}>{work.title} · {work.id}</option>)}
        </select>
      </label>}
      {!!catalog?.work&&<label>話を選ぶ
        <select aria-label="原稿ライブラリの話" disabled={busy} value={selectedEpisodeId||''} onChange={e=>run('話を選択中',()=>onSelectEpisode(e.target.value))}>
          {outline.map(item=><option key={item.id} value={item.id}>{item.chapterTitle ? `${item.chapterTitle} / ${item.title}` : item.title} · {item.id}</option>)}
        </select>
      </label>}
      {!!selectedEpisode&&<label>シーンを選ぶ
        <select aria-label="原稿ライブラリのシーン" disabled={busy} value={selectedSceneId||''} onChange={e=>run('シーンを選択中',()=>onSelectScene(e.target.value))}>
          {selectedEpisode.scenes.map(scene=><option key={scene.id} value={scene.id}>{scene.title} · {scene.id}</option>)}
        </select>
      </label>}
      {!!catalog?.work&&<small>本文・設定・人物基準画像は、catalogと同じ取得commitに固定して「GitHub側の更新を確認」から読み込みます。</small>}
    </section>
    <section aria-label="旧形式の作品登録">
      <button disabled={busy} onClick={()=>setAdding(!adding)}>作品を追加</button>
      {adding&&<div>
        <label>作品表示名<input value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>追加するGitHubリポジトリ<input value={newRepo} onChange={e=>setNewRepo(e.target.value)} placeholder="owner/repository"/></label>
        <label>最初の話ID<input value={newEpisode} onChange={e=>setNewEpisode(e.target.value)}/></label>
        <p><code>story-source/v1</code>を新規原稿の正本形式として、schema 1/4とinvestor-life-source/v1を既存作品の互換形式として読み取ります。人物画像はmanifestの宣言から取得します。</p>
        <button disabled={busy||!name.trim()||!newRepo.trim()||!newEpisode.trim()} onClick={()=>run('作品を登録中',async()=>{
          const result=await call('source_register',{name:name.trim(),repo:newRepo.trim(),episode:newEpisode.trim(),id:null});
          setLibrary({...library,entries:result.entries,active:result.id});setAdding(false);setName('');setNewRepo('');setNewEpisode('P01');
        })}>登録する</button>
      </div>}
    </section>
  </div>;
}
