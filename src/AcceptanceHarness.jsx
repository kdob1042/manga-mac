import React, { useEffect, useRef, useState } from 'react';
import { call, loadProject, saveProject } from './bridge.js';
import { imageModel } from './media.js';
import { ACCEPTANCE_MODEL, ACCEPTANCE_STAGES, createAcceptanceSession } from './acceptance.js';

export default function AcceptanceHarness({ context }) {
  const [project, setProject] = useState(null), [stages, setStages] = useState(context.stages ?? {});
  const [preview, setPreview] = useState(null), [ready, setReady] = useState(false);
  const [reportPath, setReportPath] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const lock = useRef(false), session = useRef(null);
  if (!session.current) session.current = createAcceptanceSession({ context, load: loadProject, save: saveProject,
    invoke: call, onProject: setProject, onStages: setStages, onPreview: setPreview, onReportPath: setReportPath, notify: setNotice });
  useEffect(() => { session.current.load().then(() => setReady(true)).catch(e => setError(e.message ?? String(e))); }, []);
  async function run(action) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e.message ?? String(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  const pending = project?.jobs?.some(job => ['unknown', 'candidate'].includes(job.status));
  const model = imageModel(ACCEPTANCE_MODEL);
  const diagnostic = JSON.stringify({ schema: 'manga-mac/acceptance-ui-report/v1', sessionId: context.sessionId,
    preflight: context.report, stages: Object.fromEntries(ACCEPTANCE_STAGES.map(([id]) => [id, stages[id] ?? { status: 'NOT_RUN', evidence: {} }])) }, null, 2);
  return <main aria-label="実機の最小制作確認" style={{ maxWidth: 960, margin: 'auto', padding: 32, display: 'block', overflow: 'auto', height: '100vh' }}>
    <h1>最小制作確認</h1>
    <p>確認用の短い日本語原稿から、1ページを作成して保存・再起動・PNG出力を確認します。</p>
    <p><strong>{model.display_name}</strong><br/>Mac内で256 × 256 px・4ステップ・1枚を生成します。下のボタンでこの確認に必要なモデルだけを準備してください。</p>
    <p>セッション：<code>{context.sessionId}</code> · {context.resumed ? '再起動後' : '初回起動'}</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '24px 0' }}>
      <button disabled={!ready || busy || !!pending} onClick={() => run(async () => {
        await call('prepare_media_engine', { modelId: ACCEPTANCE_MODEL });
        setNotice(`${model.display_name} の準備が完了しました。`);
      })}>この確認用モデルを準備する</button>
      <button className="primary" disabled={!ready || busy || !!pending} onClick={() => run(() => session.current.run())}>最小制作確認を実行</button>
      {pending && <button disabled={!ready || busy} onClick={() => run(() => session.current.recover())}>保存済み結果を回収</button>}
      <button disabled={!ready || busy || !context.resumed || context.stages?.adoption?.status !== 'PASS'} onClick={() => run(() => session.current.verifyRestart())}>再起動後の保存内容を確認</button>
    </div>
    {pending && <p>未確定の要求が残っています。回収は保存済み結果を照合して採用します。</p>}
    <table style={{ width: '100%', textAlign: 'left' }}>
      <thead><tr><th>確認項目</th><th>結果</th><th>次の操作</th></tr></thead>
      <tbody>{ACCEPTANCE_STAGES.map(([id, label]) => <tr key={id}><td>{label}</td><td data-testid={`acceptance-${id}`}>{stages[id]?.status ?? 'NOT_RUN'}</td><td>{stages[id]?.next ?? ''}</td></tr>)}</tbody>
    </table>
    <p>目視品質とP01実原稿の確認は、Issue #266の手順で別途記録してください。</p>
    <details><summary>診断結果</summary>
      {reportPath && <p>保存先：<code>{reportPath}</code></p>}
      <button disabled={busy} onClick={() => run(async () => {
        if (!navigator.clipboard?.writeText) throw Error('この環境では自動コピーできません。下の診断結果を選択してコピーしてください。');
        await navigator.clipboard.writeText(diagnostic); setNotice('診断結果をコピーしました。');
      })}>診断結果をコピー</button>
      <textarea aria-label="診断結果のJSON" readOnly value={diagnostic} rows={10} style={{ width: '100%' }}/>
    </details>
    {preview && <figure><img src={preview} alt="確認用原稿のPNG" style={{ maxWidth: '100%', maxHeight: 650 }}/><figcaption>確認用原稿：こんにちは。文字と保存の確認です。</figcaption></figure>}
    {!preview && project?.panels?.[0]?.image && <figure><img src={project.panels[0].image} alt="保存済みの確認用作画" style={{ maxWidth: 256 }}/><figcaption>保存済み画像を表示しています。</figcaption></figure>}
  </main>;
}
