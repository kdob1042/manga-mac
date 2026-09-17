import React, { useState, useEffect } from 'react';
import { call, desktop } from './bridge';
import { changedBaseUsers, usageLabel } from './asset-usage';

export default function BlenderSettings({ disabled, run, notify, project }) {
  const [binary, setBinary] = useState('/Applications/Blender.app/Contents/MacOS/Blender');
  const [library, setLibrary] = useState(''), [source, setSource] = useState('');
  const [assets, setAssets] = useState([]), [asset, setAsset] = useState(''), [filter, setFilter] = useState('');
  const [webUrl, setWebUrl] = useState(''), [webFileName, setWebFileName] = useState('');
  const [webPage, setWebPage] = useState(''), [webLicense, setWebLicense] = useState('');
  const [webDownload, setWebDownload] = useState(null), [webCandidates, setWebCandidates] = useState([]);
  const [webCandidate, setWebCandidate] = useState('');
  const [session, setSession] = useState(null), [lens, setLens] = useState(50);
  useEffect(() => { if (desktop()) call('blender_latest').then(setSession).catch(() => notify('Blenderの保存状態を読めませんでした')); }, []);
  const affected = project ? changedBaseUsers(project, session) : [];
  const pending = session?.jobs?.some(job => ['unknown', 'running', 'candidate'].includes(job.status));
  const refresh = async () => {
    if (!session) return;
    const current = await call('blender_status', { sessionId: session.session_id });
    setSession(current);
    if (current.state?.state?.lens) setLens(current.state.state.lens);
    return current;
  };
  const recover = (job, action) => run('Blenderの保存結果を確認中', async () => {
    const current = await call('blender_recover', {
      sessionId: session.session_id, requestId: job.id,
      expectedRevision: session.revision, action,
    });
    setSession(current);
    if (current.state?.state?.lens) setLens(current.state.state.lens);
    notify(action === 'adopt' ? '検証した保存結果を採用しました。Blenderは再実行していません。' : '現在の採用版を保持し、この要求を採用せずに解消しました。成果物は残しています。');
  });
  const operate = operation => run('Blenderで処理中', async () => {
    try {
      const result = await call('blender_execute', { request: { session_id: session.session_id, request_id: crypto.randomUUID(), expected_revision: session.revision, operation } });
      setSession(result); if (result.state?.library_assets) setAssets(result.state.library_assets); notify('Blenderの実値と保存結果を確認しました');
      return result;
    } catch (error) {
      await refresh().catch(() => notify('要求状態を取得できませんでした。状態確認を再度行ってください。'));
      throw error;
    }
  });
  const downloadWebAsset = () => run('Web素材を取得してBlenderで確認中', async () => {
    const downloaded = await call('blender_download_web_asset', {
      sessionId: session.session_id,
      expectedRevision: session.revision,
      input: { download_url: webUrl, file_name: webFileName, source_page: webPage, license: webLicense },
    });
    const result = await call('blender_execute', { request: {
      session_id: session.session_id,
      request_id: crypto.randomUUID(),
      expected_revision: session.revision,
      operation: { kind: 'webcatalog', file: downloaded.file, hash: downloaded.hash },
    } });
    setSession(result);
    setWebDownload(downloaded);
    setWebCandidates(result.state?.web_asset_candidates ?? []);
    setWebCandidate('');
    notify('Web素材を固定して、Blenderで取り込める内容を確認しました');
  });
  const importWebAsset = () => run('Web素材をBlenderへ取り込み中', async () => {
    const candidate = webCandidates[Number(webCandidate)];
    if (!candidate || !webDownload) throw Error('取り込むWeb素材を選択してください');
    const result = await call('blender_execute', { request: {
      session_id: session.session_id,
      request_id: crypto.randomUUID(),
      expected_revision: session.revision,
      operation: {
        kind: 'webimport', file: webDownload.file, hash: webDownload.hash,
        entry: candidate.entry, format: candidate.format,
        asset_type: candidate.asset_type, name: candidate.name,
        source_url: webDownload.source_url, source_page: webDownload.source_page,
        license: webDownload.license,
      },
    } });
    setSession(result);
    setWebCandidates([]);
    setWebCandidate('');
    notify('Web素材をBlenderへ取り込み、出典・ライセンス・取得ハッシュを保存しました');
  });
  const jobStatus = job => job.status === 'running' ? '処理中' : job.status === 'candidate' ? '旧版の候補' : '結果未確定';
  return <fieldset disabled={disabled}><legend>Blender 4.5.13</legend>
    <label>Blender実行ファイル<input value={binary} onChange={e => setBinary(e.target.value)}/></label>
    <label>読み込みを許可する素材フォルダ<input value={library} onChange={e => setLibrary(e.target.value)} placeholder="/Users/名前/BlenderAssets"/></label>
    <label>開くblendファイル<input value={source} onChange={e => setSource(e.target.value)} placeholder="素材フォルダ内のファイル.blend"/></label>
    <small>専用のバックグラウンド処理で開きます。元のblendと、開いているBlenderの画面は変更しません。撮影画像は漫画・動画で共通利用できます。</small>
    <button onClick={() => run('Blenderの接続を確認中', async () => {
      const created = await call('blender_register', { input: { binary, library_root: library, source } });
      setSession(created);
      try {
        const result = await call('blender_execute', { request: { session_id: created.session_id, request_id: crypto.randomUUID(), expected_revision: 0, operation: { kind: 'inspect' } } });
        setSession(result); setLens(result.state.state.lens); notify('Blenderの版・カメラ・描画設定を確認しました');
      } catch (error) {
        await call('blender_status', { sessionId: created.session_id }).then(setSession)
          .catch(() => notify('要求状態を取得できませんでした。状態確認を再度行ってください。'));
        throw error;
      }
    })}>開いて接続を確認</button>
    {session && <>
      <p>接続版：{session.revision} ／ 焦点距離：{session.state?.state?.lens ?? '未確認'} mm</p>
      <label>焦点距離（mm）<input type="number" min="10" max="250" value={lens} onChange={e => setLens(Number(e.target.value))}/></label>
      <button disabled={pending} onClick={() => operate({ kind: 'camera', lens })}>カメラを変更</button>
      <button disabled={pending} onClick={() => operate({ kind: 'catalog' })}>素材フォルダを再検索</button>
      <label>素材を絞り込む<input value={filter} onChange={e => setFilter(e.target.value)}/></label>
      <label>Blenderの既存アセット<select value={asset} onChange={e => setAsset(e.target.value)}><option value="">選択</option>{assets.map((a, i) => ({ a, i })).filter(({ a }) => `${a.name} ${a.file}`.toLowerCase().includes(filter.toLowerCase())).map(({ a, i }) => <option key={i} value={i}>{a.name} — {a.file} ({a.kind})</option>)}</select></label>
      <button disabled={pending || asset === '' || !assets[Number(asset)]} onClick={() => { const a = assets[Number(asset)]; operate({ kind: 'import', file: a.file, hash: a.hash, asset_type: a.kind, name: a.name }); }}>選択素材を舞台へ取り込む</button>
      <small>Blenderでアセットに指定されたObject・Collection・Action（ポーズ素材）を表示します。素材を更新したら再検索してください。</small>
      <details className="web-asset-import"><summary>Webの既存3D素材を取り込む</summary>
        <p>配布元で利用条件を確認し、素材ファイルの直接URLを指定します。任意スクリプトやアドオンは実行しません。</p>
        <label>素材のダウンロードURL<input type="url" value={webUrl} onChange={e => setWebUrl(e.target.value)} placeholder="https://example.com/model.glb"/></label>
        <label>保存ファイル名（URLに拡張子がない場合）<input value={webFileName} onChange={e => setWebFileName(e.target.value)} placeholder="model.glb"/></label>
        <label>配布ページURL（任意）<input type="url" value={webPage} onChange={e => setWebPage(e.target.value)} placeholder="https://example.com/assets/model"/></label>
        <label>ライセンス表記<input value={webLicense} onChange={e => setWebLicense(e.target.value)} placeholder="CC0 1.0 / 購入ライセンス名など"/></label>
        <button disabled={pending || !webUrl.trim() || !webLicense.trim()} onClick={downloadWebAsset}>取得して内容を確認</button>
        <small>HTTPSのみ、512MB以下。blend / GLB・glTF / FBX / OBJ / ZIPに対応します。ZIPは安全な相対パスと展開容量を検証します。</small>
        {!!webCandidates.length && <>
          <p>取得済み：{webDownload.file}（{Math.ceil(webDownload.bytes / 1024)} KB）</p>
          <label>取り込む内容<select aria-label="取り込むWeb素材" value={webCandidate} onChange={e => setWebCandidate(e.target.value)}><option value="">選択</option>{webCandidates.map((item, index) => <option key={`${item.entry}:${item.asset_type}:${item.name}`} value={index}>{item.label}</option>)}</select></label>
          <button disabled={pending || webCandidate === ''} onClick={importWebAsset}>選択したWeb素材を舞台へ取り込む</button>
        </>}
      </details>
      <button disabled={pending} onClick={() => operate({ kind: 'capture', width: 768, height: 768 })}>撮影する</button>
      <button onClick={() => run('Blenderの状態を確認中', async () => {
        const current = await refresh();
        notify(current.jobs.some(j => ['unknown', 'running'].includes(j.status)) ? '未確定の要求があります。自動再送は停止しています。' : '保存された接続版と要求状態を確認しました');
      })}>要求状態を確認</button>
      {session.jobs?.filter(job => ['unknown', 'running', 'candidate'].includes(job.status)).map(job => <div key={job.id}>
        <p>要求 {job.id.slice(0, 8)}：{jobStatus(job)}</p>
        <button disabled={job.status === 'running' || job.expected_revision !== session.revision} onClick={() => recover(job, 'adopt')}>保存結果を検証して採用</button>
        <button disabled={job.status === 'running'} onClick={() => recover(job, 'abandon')}>採用せずに解消</button>
      </div>)}
      {!!affected.length && <details><summary>素材元の保存版が変わった撮影・使用先（{affected.length}件）</summary><p>同じ接続から分けた旧ショットです。カメラ等の変更も含む保存版の差であり、形状変更を判定した結果ではありません。旧版は固定して保持し、自動更新・再生成しません。</p><ul>{affected.map(row => <li key={`${row.type}:${row.id}`}>{usageLabel(row)}</li>)}</ul></details>}
      {session.preview && <img src={session.preview} alt="Blenderで実際に撮影した画像" style={{ maxWidth: '100%' }}/>}
    </>}
  </fieldset>;
}
