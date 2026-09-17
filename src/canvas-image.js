import { containRect } from './image-input.js';
import { compositePixels } from './core.js';

export function imageOf(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(Error('画像を読み込めません'));
    im.src = src;
  });
}
export async function fitInput(image, width, height) {
  const source = await imageOf(image),
    rect = containRect(source.width, source.height, width, height);
  if (source.width === width && source.height === height)
    return { image, mapping: rect };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
  return { image: canvas.toDataURL('image/png'), mapping: rect };
}
export async function mergeRegion(before, after, rect) {
  if (
    !rect ||
    rect.length !== 4 ||
    rect.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
    rect[2] <= 0 ||
    rect[3] <= 0 ||
    rect[0] + rect[2] > 1.00001 ||
    rect[1] + rect[3] > 1.00001
  )
    throw Error('修正範囲を選択してください');
  const a = await imageOf(before),
    b = await imageOf(after);
  const canvas = document.createElement('canvas');
  canvas.width = a.width;
  canvas.height = a.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(a, 0, 0);
  const original = ctx.getImageData(0, 0, a.width, a.height);
  ctx.clearRect(0, 0, a.width, a.height);
  ctx.drawImage(b, 0, 0, a.width, a.height);
  const candidate = ctx.getImageData(0, 0, a.width, a.height);
  const mask = new Uint8Array(a.width * a.height);
  for (
    let y = Math.floor(rect[1] * a.height);
    y < Math.ceil((rect[1] + rect[3]) * a.height);
    y++
  )
    for (
      let x = Math.floor(rect[0] * a.width);
      x < Math.ceil((rect[0] + rect[2]) * a.width);
      x++
    )
      mask[y * a.width + x] = 1;
  original.data.set(compositePixels(original.data, candidate.data, mask));
  ctx.putImageData(original, 0, 0);
  return canvas.toDataURL('image/png');
}
