import { PAGE, artPoints } from './layout.js';
import { panelArtRect } from './page-art.js';
import { nameLetteringProblems } from './name-v2.js';

export const OUTPUT_WIDTHS = [800, 1600, 3200];

// Keep the existing composition coordinates. Only the output raster changes.
export function outputSize(options = {}) {
  const width = options.width ?? PAGE.width;
  if (!OUTPUT_WIDTHS.includes(width)) throw Error('出力幅は800・1600・3200pxから選んでください');
  return { width, height: width * PAGE.height / PAGE.width };
}

// Fast, deterministic checks only. Text fitting remains the shared renderer's job.
export function outputProblems(project) {
  const panels = new Map(project.panels.map(panel => [panel.id, panel]));
  return project.layout.pages.flatMap((page, pageIndex) => page.slots.flatMap((slot, panelIndex) => {
    const panel = panels.get(slot.panelId), target = {pageIndex,panelIndex,panelId:panel?.id??null};
    if (!panel) return [{...target,code:'unassigned',stage:'layout',message:'枠にコマが割り当てられていません'}];
    if (!panel.image) return [{...target,code:'artwork',stage:'art',message:'未作画のコマです'}];
    const lettering = nameLetteringProblems(panel);
    return lettering.length ? [{...target,code:'lettering',stage:'finish',message:lettering.map(problem=>problem.message).join(' / ')}] : [];
  }));
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
