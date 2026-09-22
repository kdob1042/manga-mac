import React from 'react';
import { candidateComparison } from './artwork-comparison.js';

export default function CandidateComparison({ project, job }) {
  const { base, candidate, current, baseMissing, baseChanged, sourceChanged } = candidateComparison(project, job);
  if (!candidate?.image) return <p>比較する候補画像が見つかりません。</p>;
  return <div aria-label="作画候補の比較">
    {baseChanged && <p>候補の作成後に採用画像が変わっています。作成時の元画像と、現在の採用画像を分けて表示します。</p>}
    {sourceChanged && <p>候補の作成後に対象原稿が変わっています。</p>}
    {baseMissing && <p>候補の元画像が見つかりません。</p>}
    <div className="art-comparison-grid">
      {base?.image && <figure className="art-comparison-card"><img src={base.image} alt="候補の元画像" decoding="async"/><figcaption>候補の元画像</figcaption></figure>}
      <figure className="art-comparison-card"><img src={candidate.image} alt="新しい作画候補" decoding="async"/><figcaption>新しい作画候補</figcaption></figure>
      {baseChanged && current?.image && <figure className="art-comparison-card"><img src={current.image} alt="現在の採用画像" decoding="async"/><figcaption>現在の採用画像</figcaption></figure>}
    </div>
  </div>;
}
