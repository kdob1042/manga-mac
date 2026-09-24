import React, {useEffect,useRef} from "react";
import LLMSettings from "./LLMSettings";
import JevSettings from "./JevSettings";
import BlenderSettings from "./BlenderSettings";
import BackupSettings from "./BackupSettings";
import { protocolLabel } from "./source-protocol";
import { call } from "./bridge";
import { download } from "./export.js";
import CloudImageSettings from './CloudImageSettings.jsx';
import TapNowSettings from './TapNowSettings.jsx';
import {imageModels,imageModel} from './media.js';
export default function SettingsPanel({
  setSettings,
  repo,
  library,
  busy,
  setRepo,
  setPending,
  setNotice,
  episode,
  setEpisode,
  token,
  setToken,
  snapshot,
  ready,
  run,
  checkSync,
  project,
  name,
  setName,
  description,
  setDescription,
  addCharacter,
  commit,
  current,
  model,
  setModel,
  jev,
  setJev,
  imageModelId,
  setImageModelId,
  sourceBranch
}) {
  const selectedImageModel=imageModel(imageModelId), closeButton=useRef(null);
  useEffect(()=>{const previous=document.activeElement;closeButton.current?.focus();return()=>previous?.focus?.();},[]);
  return <section className="settings" aria-label="設定" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setSettings(false);}}}>
    <div className="setting-head">
    <h2>設定</h2>
    <button ref={closeButton} onClick={() => setSettings(false)}>閉じる</button>
    </div>
    <details open={!library?.entries.some(e=>e.id===library.active&&e.work_id)}><summary>旧形式の原稿接続</summary>
    <label>GitHubリポジトリ<input value={repo} readOnly={!!library?.entries.some(e => e.id === library.active)} disabled={!!busy} onChange={e => {
        setRepo(e.target.value);
        setPending(null);
        setNotice("");
      }} />
    </label>
    <label>話ID<input value={episode} disabled={!!busy} onChange={e => {
        setEpisode(e.target.value);
        setPending(null);
        setNotice("");
      }} placeholder="P01" />
    </label>
    <label>読み取り専用トークン<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} />
    </label>
    <small>トークンは今回の起動中だけ保持。原作リポジトリのContents: readを使用します。</small>{snapshot && <div className="source-status">
    <strong>使用中の原稿</strong>
    <span>{snapshot.repo} / {snapshot.sync?.source_branch??sourceBranch} @ {snapshot.sha.slice(0, 8)}</span>
    <span>{protocolLabel(snapshot)}</span>
    </div>}<button disabled={!!busy||!ready} onClick={()=>run('旧形式の原稿を確認中',checkSync)}>GitHub側の更新を確認</button></details>
    <details><summary>人物と画風の参照</summary>
    <small>原稿で宣言された人物参照画像は、原稿版を取り込むと同じcommitから自動登録されます。</small>
    <div className="characters">{project.characters.map(c => <div key={c.id}>
    <img src={c.image} />
    <span>{c.name}<small>v{c.version} · {c.hash.slice(0, 8)}{c.source ? " · 原作連携" : ""}</small>
    </span>
    </div>)}</div>
    <label>人物名<input value={name} onChange={e => setName(e.target.value)} placeholder="人物名" />
    </label>
    <label>固定する特徴<textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="髪型・体格・衣装など" />
    </label>
    <label className="file">＋ 正本画像を登録<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy || !ready} onChange={e => {
        const file = e.target.files[0];
        run("参照を登録", () => addCharacter(file));
        e.target.value = "";
      }} />
    </label>
    <h3>画風参照</h3>
    <div className="characters">{project.style_references?.map(style => <div key={style.id}>
    <img src={style.image} />
    <span>{style.name}</span>
    <button disabled={!!busy} onClick={() => run("画風参照を外す", async () => commit({
          ...current.current,
          style_references: current.current.style_references.filter(s => s.id !== style.id)
        }))}>外す</button>
    </div>)}</div>
    <label className="file">＋ 画風参照を登録<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy || !ready} onChange={e => {
        const file = e.target.files[0];
        run("画風参照を登録", () => addCharacter(file, true));
        e.target.value = "";
      }} />
    </label>
    </details>
    <h3>AIの接続</h3>
    <LLMSettings title="演出・コマ計画" value={model} onChange={setModel} disabled={!!busy} run={run} notify={setNotice} />
    <small>演出・コマ計画の接続は、漫画と動画で共通する英訳の作成にも使用します。</small>
    <JevSettings value={jev} onChange={setJev} run={run} busy={!!busy} />
    <label>画像生成モデル<select aria-label="画像生成モデル" disabled={!!busy} value={imageModelId} onChange={e=>run('画像モデルを選択',async()=>{
      const next=e.target.value;
      await commit({...current.current,mediaDefaults:{...current.current.mediaDefaults,image:next}});
      setImageModelId(next);
    })}>{imageModels.map(item=><option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
    <small>{selectedImageModel.locality==='local'?'Mac内で生成します。':'生成時に画像をクラウドへ送信します。'} 別モデルへ自動で切り替えません。</small>
    <button disabled={!!busy||!selectedImageModel.requires_preparation} className="full" onClick={() => run("画像モデルを準備中（初回ダウンロード）", async () => {
      await call("prepare_media_engine", {modelId:imageModelId});
      setNotice("画像モデルの準備が完了しました");
    })}>画像モデルを準備する</button>
    <small>必要なモデルだけ、この操作でダウンロードします。</small>
    <CloudImageSettings current={current} commit={commit} run={run} busy={!!busy}/>
    <TapNowSettings busy={busy} run={run}/>
    <h3>Blenderで撮影する</h3>
    <BlenderSettings project={project} current={current} commit={commit} disabled={!!busy} run={run} notify={setNotice} />
    <BackupSettings disabled={!!busy || !ready} />
    <h3>作品JSONの書き出し</h3>
    <small>このJSONだけでは動画・Blender素材は復元できません。完全な復元にはクラウドバックアップを使用します。</small>
    <button disabled={!ready || !!busy} onClick={() => run("作品をバックアップ", async () => {
      await download(new Blob([JSON.stringify(project)], {
        type: "application/json"
      }), "manga-project.json");
      setNotice("作品JSONを書き出しました。Macではダウンロード / Manga Mac に保存されます。");
    })}>作品データを書き出す</button>
    </section>;
}
