import { ensureLayout, layoutWarnings, pagePanels } from './layout.js';
import { pagePNG } from './render.js';
import { call, desktop } from './bridge.js';
import { outputSize } from './output.js';

export async function exportCBZ(project, options = {}) {
  const output = outputSize(options);
  if (!project.panels.length) throw Error('書き出すページがありません');
  project = ensureLayout(project);
  const warnings = layoutWarnings(project.layout, project.panels);
  if (warnings.length) throw Error(warnings.join(' / '));
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const [i, page] of project.layout.pages.entries())
    zip.file(
      `${String(i + 1).padStart(3, '0')}.png`,
      (
        await pagePNG(
          pagePanels(project, page),
          project.snapshots,
          project.localizations,
          project.output_locale,
          page,
          false,
          project.layout.imageCrops,
          output,
        )
      ).split(',')[1],
      { base64: true },
    );
  zip.file(
    'provenance.json',
    JSON.stringify(
      {
        output,
        layout: project.layout,
        locale: project.output_locale,
        sources: project.snapshots.map(({ repo, sha, id }) => ({
          repo,
          sha,
          id,
        })),
        localizations:
          project.output_locale === 'en'
            ? project.localizations.map(({ units, ...item }) => ({
                ...item,
                unit_ids: units.map((unit) => unit.id),
              }))
            : [],
        panels: project.panels.map(({ image, ...p }) => p),
      },
      null,
      2,
    ),
  );
  return zip.generateAsync({ type: 'blob' });
}
export async function download(blob, name) {
  if (desktop()) {
    const data = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < data.length; i += 32768)
      binary += String.fromCharCode(...data.subarray(i, i + 32768));
    return call('export_file', { name, data: btoa(binary) });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
