import React, { useEffect, useMemo, useState } from 'react';
import { pagePNG } from './render.js';

export default function PageProof({ panels, snapshots, localizations, locale, page, imageCrops }) {
  const input = useMemo(() => ({ panels, snapshots, localizations, locale, page, imageCrops }),
    [panels, snapshots, localizations, locale, page, imageCrops]);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!page?.slots.length || !panels.length) return;
    let stale = false;
    pagePNG(panels, snapshots, localizations, locale, page, false, imageCrops)
      .then(image => { if (!stale) setResult({ input, image }); })
      .catch(error => { if (!stale) setResult({ input, error: error.message ?? String(error) }); });
    return () => { stale = true; };
  }, [input]);

  if (!page?.slots.length || !panels.length) return <p className="stage-hint">このページにはコマがありません。コマ割り編集で配置してください。</p>;
  // A previous page or saved version is never a preview of the current input,
  // including the render before its replacement effect has started.
  if (result?.input !== input) return <p role="status" className="stage-hint">仕上がりを確認中…</p>;
  if (result.error) return <p role="alert" className="message error">仕上がりを表示できません: {result.error}</p>;
  return <img className="page-proof" src={result.image} alt="書き出しページの確認"/>;
}
