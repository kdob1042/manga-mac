import React, { useEffect, useMemo, useState } from 'react';
import { pagePNG } from './render.js';

export default function PageProof({ panels, snapshots, localizations, locale, page, imageCrops, draft = false, hideUnplacedCaptions = false, children }) {
  const input = useMemo(() => ({ panels, snapshots, localizations, locale, page, imageCrops, draft, hideUnplacedCaptions }),
    [panels, snapshots, localizations, locale, page, imageCrops, draft, hideUnplacedCaptions]);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!page?.slots.length || !panels.length) return;
    let stale = false;
    pagePNG(panels, snapshots, localizations, locale, page, draft, imageCrops, {hideUnplacedCaptions})
      .then(image => { if (!stale) setResult({ input, image }); })
      .catch(error => { if (!stale) setResult({ input, error: error.message ?? String(error) }); });
    return () => { stale = true; };
  }, [input]);

  if (!page?.slots.length || !panels.length) return <p className="stage-hint">このページにはコマがありません。コマ割り編集で配置してください。</p>;
  // A previous page or saved version is never a preview of the current input,
  // including the render before its replacement effect has started.
  const loading=result?.input!==input;
  // Keep the page's physical box through async renders and image decoding.
  // Removing it here collapses the scroller and moves the next drag target.
  return <div className="page-proof-frame" aria-busy={loading}>
    {loading?<p role="status" className="page-proof-status">ページを描画中…</p>
      :result.error?<p role="alert" className="page-proof-status message error">ページを表示できません: {result.error}</p>
      :<><img className="page-proof" width="1600" height="2260" draggable="false" src={result.image} alt={draft ? '作画ページの確認' : '書き出しページの確認'}/>{children}</>}
  </div>;
}
