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
export function panelLayout(i, width, height) {
  const x = i % 2 === 0 ? 820 : 60, y = 60 + Math.floor(i / 2) * 1080;
  const fit = containRect(width, height, 716, 716);
  return { frame: { x, y, width: 720, height: 1030 }, artRect: { x: x + 2 + fit.x, y: y + 2 + fit.y, width: fit.width, height: fit.height } };
}
export async function pageLayers(panels, snapshots, localizations = [], locale = 'ja', layer = 'complete') {
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 2260;
  const ctx = canvas.getContext('2d'); if (layer !== 'overlay') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1600, 2260); }
  for (const [i, p] of panels.entries()) {
    const x = i % 2 === 0 ? 820 : 60, y = 60 + Math.floor(i / 2) * 1080;
    if (layer !== 'art') { ctx.strokeStyle = '#111'; ctx.lineWidth = 4; ctx.strokeRect(x, y, 720, 1030); }
    if (!p.image) throw Error('未作画のコマがあります');
    const image = await imageOf(p.image), { artRect: fit } = panelLayout(i, image.width, image.height);
    if (layer !== 'overlay') ctx.drawImage(image, fit.x, fit.y, fit.width, fit.height);
    if (layer === 'art') continue;
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
  }
  return canvas.toDataURL('image/png');
}
export const pagePNG = (panels, snapshots, localizations = [], locale = 'ja') => pageLayers(panels, snapshots, localizations, locale);
export async function exportCBZ(project) {
  if (!project.panels.length) throw Error('書き出すページがありません');
  const zip = new JSZip();
  for (let i = 0; i < project.panels.length; i += 4) zip.file(`${String(i / 4 + 1).padStart(3, '0')}.png`, (await pagePNG(project.panels.slice(i, i + 4), project.snapshots, project.localizations, project.output_locale)).split(',')[1], { base64: true });
  zip.file('provenance.json', JSON.stringify({ locale: project.output_locale, sources: project.snapshots.map(({ repo, sha, id }) => ({ repo, sha, id })), localizations: project.output_locale === 'en' ? project.localizations.map(({ units, ...item }) => ({ ...item, unit_ids: units.map(unit => unit.id) })) : [], panels: project.panels.map(({ image, ...p }) => p) }, null, 2));
  return zip.generateAsync({ type: 'blob' });
}
export async function download(blob, name) { if (desktop()) { const data = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768)); return call('export_file', { name, data: btoa(binary) }); } const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
