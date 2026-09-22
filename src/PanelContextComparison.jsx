import React, { useState } from 'react';
import { panelContext } from './artwork-comparison.js';

const labels = { previous: '前のコマ', current: '選択中のコマ', next: '次のコマ' };

export default function PanelContextComparison({ project, panelId }) {
  const [open, setOpen] = useState(false);
  const context = open ? panelContext(project, panelId) : null;
  return <details className="shot-controls panel-context" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>前後のコマ・人物参照</summary>
    {context && <>
      <div className="art-comparison-grid" aria-label="前後のコマ">
        {context.rows.map(row => <figure className="art-comparison-card" key={row.position}>
          {row.panel.image ? <img src={row.panel.image} alt={labels[row.position]} decoding="async"/> : <div className="art-comparison-empty">未作画</div>}
          <figcaption>{labels[row.position]}{row.pageNumber ? ` · ${row.pageNumber}ページ ${row.panelNumber}コマ目` : ''}{row.differentEpisode ? '（別の話）' : row.differentScene ? '（別の場面）' : ''}</figcaption>
        </figure>)}
      </div>
      {context.characters.length > 0 && <div className="art-reference-grid" aria-label="選択コマの人物参照">
        {context.characters.map(character => <figure className="art-comparison-card" key={character.id}>
          {character.image ? <img src={character.image} alt={`人物参照: ${character.name}`} loading="lazy" decoding="async"/> : <div className="art-comparison-empty">参照画像なし</div>}
          <figcaption>{character.name}</figcaption>
        </figure>)}
      </div>}
    </>}
  </details>;
}
