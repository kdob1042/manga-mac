import React, { useMemo, useState } from 'react';
import { OUTPUT_WIDTHS, outputSize, outputResolution } from './output.js';
import { videoFrameDimensions } from './video.js';
import { exportCBZ, download } from './export.js';
import { exportLiveManga } from './live-export.js';
import { pagePNG } from './render.js';
import { pagePanels } from './layout.js';
import { desktop } from './bridge.js';

export default function ExportControls({ project, current, pageIndex, busy, run, notify, onInspect, active }) {
  const [width, setWidth] = useState(1600), output = outputSize({ width });
  const problems = useMemo(() => active ? outputResolution(project, { width }, videoFrameDimensions) : [], [active, project, width]);
  return <div className="export-options">
    <label>PNG・CBZの出力幅<select aria-label="PNG・CBZの出力幅" value={width} disabled={busy} onChange={e => setWidth(Number(e.target.value))}>
      {OUTPUT_WIDTHS.map(value => <option key={value} value={value}>{value}px{value === 1600 ? '（標準）' : ''}</option>)}
    </select></label>
    <small>{output.width} × {output.height}px · ページ比率は共通</small>
    <button disabled={busy || !project.layout.pages[pageIndex]?.slots.length} onClick={() => run('PNGを書き出し', async () => {
      const p = current.current, page = p.layout.pages[pageIndex];
      const data = await pagePNG(pagePanels(p, page), p.snapshots, p.localizations, p.output_locale, page, false, p.layout.imageCrops, output);
      await download(new Blob([Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0))], { type: 'image/png' }), `page-${pageIndex + 1}-${p.output_locale}.png`);
    })}>PNG</button>
    <button disabled={busy || !project.panels.length} onClick={() => run('書き出し中', async () => {
      const p = current.current;
      await download(await exportCBZ(p, output), `manga-${p.output_locale}.cbz`);
    })}>CBZを書き出す ↗</button>
    {problems.length > 0 && <details className="output-resolution"><summary>画像解像度を確認 · 全体で{problems.length}コマ</summary>
      <p>大きく出力しても作画の細部は増えません。必要なコマだけ仕上げ直せます。</p>
      <ul>{problems.map(row => <li key={`${row.pageIndex}:${row.panelIndex}`}><button type="button" onClick={() => onInspect({...row, outputWidth:width})}>
        {row.pageIndex + 1}ページ · {row.panelIndex + 1}コマ目
      </button><small>{row.unknown ? '画像寸法を確認できません' : `${row.width}×${row.height} → 必要 ${row.requiredWidth}×${row.requiredHeight}px（${row.scale.toFixed(1)}倍）`}</small></li>)}</ul>
    </details>}
    <button disabled={busy || !project.panels.length || !desktop()} onClick={() => run('Live Mangaを書き出し中', async () => {
      const result = await exportLiveManga(structuredClone(current.current));
      notify(`Live Manga ${result.releaseId} · ${result.path} · 検証済み`);
    })}>Live Mangaを書き出す</button>
    <small>Live Mangaは1600 × 2260px</small>
  </div>;
}
