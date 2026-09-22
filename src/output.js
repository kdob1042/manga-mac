import { PAGE, artPoints } from './layout.js';
import { panelArtRect } from './page-art.js';

export const OUTPUT_WIDTHS = [800, 1600, 3200];

// Keep the existing composition coordinates. Only the output raster changes.
export function outputSize(options = {}) {
  const width = options.width ?? PAGE.width;
  if (!OUTPUT_WIDTHS.includes(width)) throw Error('出力幅は800・1600・3200pxから選んでください');
  return { width, height: width * PAGE.height / PAGE.width };
}

export function outputResolution(project, options, dimensions) {
  const output = outputSize(options), rows = [];
  for (const [pageIndex, page] of project.layout.pages.entries()) {
    for (const [panelIndex, slot] of page.slots.entries()) {
      const panel = project.panels.find(p => p.id === slot.panelId);
      if (!panel?.image) continue; // Missing artwork is handled by the existing strict renderer.
      const row = { panelId: panel.id, pageIndex, panelIndex };
      let source;
      try { source = dimensions(panel.image); } catch { rows.push({ ...row, unknown: true }); continue; }
      const rect = panelArtRect(artPoints(slot), source.width, source.height, project.layout.imageCrops?.[panel.id]);
      const scale = rect.width / source.width * output.width / PAGE.width;
      if (scale > 1.001) rows.push({ ...row, scale, width: source.width, height: source.height,
        requiredWidth: Math.ceil(source.width * scale), requiredHeight: Math.ceil(source.height * scale) });
    }
  }
  return rows;
}
