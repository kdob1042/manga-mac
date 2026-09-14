import JSZip from 'jszip';
import { compositePixels, sourceForPanel } from './core';
export function imageOf(src) { return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(Error('画像を読み込めません')); im.src = src; }); }
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
export function lines(ctx, text, width) {
  const result = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const c of paragraph) { if (ctx.measureText(line + c).width > width && line) { result.push(line); line = ''; } line += c; }
    result.push(line);
  }
  return result;
}
export async function pagePNG(panels, snapshots) {
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 2260;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1600, 2260);
  for (const [i, p] of panels.entries()) {
    const x = i % 2 === 0 ? 820 : 60, y = 60 + Math.floor(i / 2) * 1080;
    ctx.strokeStyle = '#111'; ctx.lineWidth = 4; ctx.strokeRect(x, y, 720, 1030);
    if (!p.image) throw Error('未作画のコマがあります');
    ctx.drawImage(await imageOf(p.image), x + 2, y + 2, 716, 716);
    const text = sourceForPanel(p, snapshots.find(s => s.id === p.snapshotId));
    ctx.font = '24px sans-serif'; ctx.fillStyle = '#111';
    const wrapped = lines(ctx, text, 676);
    if (wrapped.length > 10) throw Error('文字がコマに収まりません。コマ計画を細分化してから書き出してください');
    wrapped.forEach((l, j) => ctx.fillText(l, x + 22, y + 758 + j * 27));
  }
  return canvas.toDataURL('image/png');
}
export async function exportCBZ(project) {
  if (!project.panels.length) throw Error('書き出すページがありません');
  const zip = new JSZip();
  for (let i = 0; i < project.panels.length; i += 4) zip.file(`${String(i / 4 + 1).padStart(3, '0')}.png`, (await pagePNG(project.panels.slice(i, i + 4), project.snapshots)).split(',')[1], { base64: true });
  zip.file('provenance.json', JSON.stringify({ sources: project.snapshots.map(({ repo, sha, id }) => ({ repo, sha, id })), panels: project.panels.map(({ image, ...p }) => p) }, null, 2));
  return zip.generateAsync({ type: 'blob' });
}
export function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
