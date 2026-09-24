import React from 'react';
import {bounds} from './layout.js';

// Thumbnail geometry follows the saved page rather than a fixed two-column grid.
export default function PageThumbnail({page, panels}) {
  const byId = new Map(panels.map(panel => [panel.id, panel]));
  return <div className="mini-page" aria-hidden="true">
    {page.slots.map(slot => {
      const box = bounds(slot.points);
      const polygon = slot.points.map(([x, y]) => `${(x-box.x)/box.width*100}% ${(y-box.y)/box.height*100}%`).join(', ');
      const panel = byId.get(slot.panelId);
      return <div className="mini-page-panel" key={slot.id} style={{
        left: `${box.x*100}%`, top: `${box.y*100}%`,
        width: `${box.width*100}%`, height: `${box.height*100}%`,
        clipPath: `polygon(${polygon})`,
      }}>{panel?.image ? <img src={panel.image} loading="lazy" decoding="async" alt=""/> : <span>{panel ? '未作画' : '未割当'}</span>}</div>;
    })}
  </div>;
}
