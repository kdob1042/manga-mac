import { initialLayout, ensureLayout, validateLayout, layoutWarnings, pagePanels, contentBox, PAGE } from './layout.js';
import { wrapText, validateLettering } from './lettering';
import { containRect } from './image-input';
import JSZip from 'jszip';
import { call, desktop } from './bridge';
import { compositePixels } from './core';
import { textForPanel } from './localization';
export function imageOf(src) { return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(Error('画像を読み込めません')); im.src = src; }); }
export async function fitInput(image, width, height) {
  const source = await imageOf(image), rect = containRect(source.width, source.height, width, height);
  if (source.width === width && source.height === height) return { image, mapping: rect };
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
  return { image: canvas.toDataURL('image/png'), mapping: rect };
}
export async function mergeRegion(before, after, rect) {
  if (!rect || rect.length !== 4 || rect.some(n => !Number.isFinite(n) || n < 0 || n > 1) || rect[2] <= 0 || rect[3] <= 0 || rect[0] + rect[2] > 1.00001 || rect[1] + rect[3] > 1.00001) throw Error('修正範囲を選択してください');
  const a = await imageOf(before), b = await imageOf(after);
  const canvas = document.createElement('canvas'); canvas.width = a.width; canvas.height = a.height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(a, 0, 0); const original = ctx.getImageData(0, 0, a.width, a.height);
  ctx.clearRect(0, 0, a.width, a.height); ctx.drawImage(b, 0, 0, a.width, a.height); const candidate = ctx.getImageData(0, 0, a.width, a.height);
  const mask = new Uint8Array(a.width * a.height);
  for (let y = Math.floor(rect[1] * a.height); y < Math.ceil((rect[1] + rect[3]) * a.height); y++) for (let x = Math.floor(rect[0] * a.width); x < Math.ceil((rect[0] + rect[2]) * a.width); x++) mask[y * a.width + x] = 1;
  original.data.set(compositePixels(original.data, candidate.data, mask)); ctx.putImageData(original, 0, 0);
  return canvas.toDataURL('image/png');
}
export function lines(ctx, text, width) { return wrapText(text, value => ctx.measureText(value).width, width); }
function drawLettering(ctx, text, box, balloon) {
  const padding = 12;
  let size = 24, wrapped;
  for (; size >= 14; size--) {
    ctx.font = `${size}px sans-serif`;
    wrapped = lines(ctx, text, box.width - padding * 2);
    if (wrapped.length * size * 1.25 <= box.height - padding * 2 && wrapped.every(line => ctx.measureText(line).width <= box.width - padding)) break;
  }
  if (size < 14) throw Error('文字が枠に収まりません。文字枠を広げるか、コマ計画を細分化してください');
  if (balloon) { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(box.x, box.y, box.width, box.height, 18); ctx.fill(); ctx.stroke(); }
  ctx.fillStyle = '#111'; ctx.textBaseline = 'top';
  wrapped.forEach((line, i) => ctx.fillText(line, box.x + padding, box.y + padding + i * size * 1.25));
}
export async function pagePNG(panels, snapshots, localizations = [], locale = 'ja', page = null, draft = false) {
  page ??= initialLayout(panels).pages[0] ?? { id: 'empty', slots: [] };
  validateLayout({version:1,pages:[page]}, panels);
  if(!draft){const warnings=layoutWarnings({version:1,pages:[page]},panels);if(warnings.length)throw Error(warnings.join(' / '));}
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 2260;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1600, 2260);
  for (const slot of page.slots) {
    const p = panels.find(p=>p.id===slot.panelId);
    ctx.save(); ctx.beginPath(); slot.points.forEach(([x,y],i)=>i ? ctx.lineTo(x*PAGE.width,y*PAGE.height) : ctx.moveTo(x*PAGE.width,y*PAGE.height)); ctx.closePath();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 4; ctx.stroke(); ctx.clip();
    if (!p && !draft) throw Error('未割当の枠があります');
    const box=contentBox(slot.points);
    // Uniformly scale the original composition; characters and lettering never shear.
    const scale=Math.min(box.width/720,box.height/1030);
    const x=0,y=0; ctx.translate(box.x+(box.width-720*scale)/2,box.y+(box.height-1030*scale)/2);ctx.scale(scale,scale);
    if (!p) { ctx.fillStyle='#777';ctx.font='30px sans-serif';ctx.fillText('未割当',30,50);ctx.restore();continue; }
    if (!p.image && !draft) throw Error(`未作画のコマ: ${p.id}`);
    if(p.image) {
      const image = await imageOf(p.image), fit = containRect(image.width, image.height, 716, 716);
      ctx.drawImage(image, x + 2 + fit.x, y + 2 + fit.y, fit.width, fit.height);
    } else {ctx.fillStyle='#f2f0eb';ctx.fillRect(2,2,716,716);ctx.fillStyle='#777';ctx.font='30px sans-serif';ctx.fillText('未作画',30,50);}
    if(scale*14<6) throw Error(`コマ ${p.id} の文字が小さすぎます。枠を広げてください`);
    const snapshot = snapshots.find(s => s.id === p.snapshotId);
    const localization = locale === 'en' ? localizations.find(item => item.locale === 'en' && item.snapshot_id === p.snapshotId) : null;
    if (locale === 'en' && !localization) throw Error('現在の原作に対応する英訳がありません');
    const text = textForPanel(p, snapshot, localization);
    if (p.lettering?.mode === 'balloons') {
      const layout = validateLettering(p, p.lettering);
      for (const box of layout.boxes) {
        const unitText = textForPanel({ ...p, unitIds: [box.unit_id] }, snapshot, localization);
        drawLettering(ctx, unitText, { x: x + 2 + box.x * 716, y: y + 2 + box.y * 716, width: box.width * 716, height: box.height * 716 }, true);
      }
    } else drawLettering(ctx, text, { x: x + 10, y: y + 736, width: 700, height: 280 }, false);
    ctx.restore();
  }
  return canvas.toDataURL('image/png');
}
export async function exportCBZ(project) {
  if (!project.panels.length) throw Error('書き出すページがありません');
  project=ensureLayout(project);
  const warnings=layoutWarnings(project.layout,project.panels); if(warnings.length) throw Error(warnings.join(' / '));
  const zip = new JSZip();
  for (const [i,page] of project.layout.pages.entries()) zip.file(`${String(i + 1).padStart(3, '0')}.png`, (await pagePNG(pagePanels(project,page), project.snapshots, project.localizations, project.output_locale,page)).split(',')[1], { base64: true });
  zip.file('provenance.json', JSON.stringify({ layout: project.layout, locale: project.output_locale, sources: project.snapshots.map(({ repo, sha, id }) => ({ repo, sha, id })), localizations: project.output_locale === 'en' ? project.localizations.map(({ units, ...item }) => ({ ...item, unit_ids: units.map(unit => unit.id) })) : [], panels: project.panels.map(({ image, ...p }) => p) }, null, 2));
  return zip.generateAsync({ type: 'blob' });
}
export async function download(blob, name) { if (desktop()) { const data = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768)); return call('export_file', { name, data: btoa(binary) }); } const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
