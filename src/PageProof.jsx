import React, { useEffect, useMemo, useState } from 'react';
import { pagePNG } from './render.js';

export default function PageProof({ panels, snapshots, localizations, locale, page, imageCrops, draft = false, children }) {
  const input = useMemo(() => ({ panels, snapshots, localizations, locale, page, imageCrops, draft }),
    [panels, snapshots, localizations, locale, page, imageCrops, draft]);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!page?.slots.length || !panels.length) return;
    let stale = false;
    pagePNG(panels, snapshots, localizations, locale, page, draft, imageCrops)
      .then(image => { if (!stale) setResult({ input, image }); })
      .catch(error => { if (!stale) setResult({ input, error: error.message ?? String(error) }); });
    return () => { stale = true; };
  }, [input]);

  if (!page?.slots.length || !panels.length) return <p className="stage-hint">このページにはコマがありません。コマ割り編集で配置してください。</p>;
  // A previous page or saved version is never a preview of the current input,
  // including the render before its replacement effect has started.
  if (result?.input !== input) return <p role="status" className="stage-hint">ページを描画中…</p>;
  if (result.error) return <p role="alert" className="message error">ページを表示できません: {result.error}</p>;
  return <div className="page-proof-frame"><img className="page-proof" src={result.image} alt={draft ? '作画ページの確認' : '書き出しページの確認'}/>{children}</div>;
}
