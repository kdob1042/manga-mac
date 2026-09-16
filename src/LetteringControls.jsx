import React, { useState } from 'react';
import { defaultLettering, setLettering } from './lettering';
export default function LetteringControls({ panel, current, commit, run, busy }) {
  const [layout, setLayout] = useState(() => structuredClone(panel.lettering ?? defaultLettering(panel)));
  const [index, setIndex] = useState(0), box = layout.boxes[index];
  return <fieldset className="shot-controls" disabled={busy}><legend>文字配置</legend>
    <label>配置方法<select value={layout.mode} onChange={e => setLayout({ ...layout, mode: e.target.value })}><option value="caption">絵の下に本文</option><option value="balloons">コマ内の文字枠</option></select></label>
    {layout.mode === 'balloons' && box && <><label>原文の段落<select value={index} onChange={e => setIndex(Number(e.target.value))}>{layout.boxes.map((b, i) => <option key={b.unit_id} value={i}>{i + 1} · {b.unit_id}</option>)}</select></label>{[['x','横位置'],['y','縦位置'],['width','幅'],['height','高さ']].map(([key, label]) => <label key={key}>{label}<input type="number" min="0" max="1" step="0.01" value={box[key]} onChange={e => setLayout({ ...layout, boxes: layout.boxes.map((b, i) => i === index ? { ...b, [key]: Number(e.target.value) } : b) })}/></label>)}</>}
    <button onClick={() => run('文字配置を保存中', async () => commit(setLettering(current.current, panel.id, layout)))}>文字配置を適用</button><small>本文・話者・段落順は原作を保持します。ページ確認で配置を確認できます。</small>
  </fieldset>;
}
