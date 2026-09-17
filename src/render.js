import {
  initialLayout,
  validateLayout,
  layoutWarnings,
  contentBox,
  bounds,
  PAGE,
} from './layout.js';
import { cropRect } from './image-crop.js';
import { wrapText, validateLettering } from './lettering';
import { containRect } from './image-input';
import { createTextResolver } from './localization.js';
import { imageOf } from './canvas-image.js';
export function lines(ctx, text, width) {
  return wrapText(text, (value) => ctx.measureText(value).width, width);
}
export function drawLettering(ctx, text, box, balloon, style = {}) {
  const padding = style.padding ?? 12,
    lineHeight = style.lineHeight ?? 1.25;
  const inset =
    style.shape === 'ellipse' ? Math.min(box.width, box.height) * 0.15 : 0;
  const textBox = {
    x: box.x + inset,
    y: box.y + inset,
    width: box.width - inset * 2,
    height: box.height - inset * 2,
  };
  let size = style.fontSize ?? 24,
    wrapped;
  const minimum = style.fontSize ?? 14;
  for (; size >= minimum; size--) {
    ctx.font = `${size}px sans-serif`;
    wrapped = lines(ctx, text, textBox.width - padding * 2);
    if (
      wrapped.length * size * lineHeight <= textBox.height - padding * 2 &&
      wrapped.every(
        (line) => ctx.measureText(line).width <= textBox.width - padding,
      )
    )
      break;
  }
  if (size < minimum)
    throw Error(
      '文字が枠に収まりません。文字枠を広げるか、コマ計画を細分化してください',
    );
  if (balloon) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    if (style.tail) {
      ctx.beginPath();
      ctx.moveTo(box.x + box.width * 0.4, box.y + box.height * 0.5);
      ctx.lineTo(2 + style.tail[0] * 716, 2 + style.tail[1] * 716);
      ctx.lineTo(box.x + box.width * 0.6, box.y + box.height * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    if (style.shape === 'ellipse')
      ctx.ellipse(
        box.x + box.width / 2,
        box.y + box.height / 2,
        box.width / 2,
        box.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    else if (style.shape === 'rect')
      ctx.rect(box.x, box.y, box.width, box.height);
    else
      ctx.roundRect(
        box.x,
        box.y,
        box.width,
        box.height,
        Math.min(18, box.width / 2, box.height / 2),
      );
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'top';
  wrapped.forEach((line, i) =>
    ctx.fillText(
      line,
      textBox.x + padding,
      textBox.y + padding + i * size * lineHeight,
    ),
  );
}
export async function pageLayers(
  panels,
  snapshots,
  localizations = [],
  locale = 'ja',
  layer = 'complete',
  page = null,
  draft = false,
  imageCrops = {},
) {
  page ??= initialLayout(panels).pages[0] ?? { id: 'empty', slots: [] };
  validateLayout({ version: 1, pages: [page] }, panels);
  if (!draft) {
    const warnings = layoutWarnings({ version: 1, pages: [page] }, panels);
    if (warnings.length) throw Error(warnings.join(' / '));
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 2260;
  const ctx = canvas.getContext('2d');
  if (layer !== 'overlay') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1600, 2260);
  }
  // Request-scoped indexes: no global cache retains artwork or stale source text.
  const resolveText = new Map();
  for (const slot of page.slots) {
    const p = panels.find((p) => p.id === slot.panelId);
    ctx.save();
    ctx.beginPath();
    slot.points.forEach(([x, y], i) =>
      i
        ? ctx.lineTo(x * PAGE.width, y * PAGE.height)
        : ctx.moveTo(x * PAGE.width, y * PAGE.height),
    );
    ctx.closePath();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 4;
    if (layer !== 'art') ctx.stroke();
    ctx.clip();
    if (!p && !draft) throw Error('未割当の枠があります');
    const box = contentBox(slot.points);
    const crop = p && imageCrops[p.id];
    const image = p?.image ? await imageOf(p.image) : null;
    if (crop && p.image && layer !== 'overlay') {
      const im = image,
        b = bounds(slot.points);
      const r = cropRect(
        im.width,
        im.height,
        {
          x: b.x * PAGE.width,
          y: b.y * PAGE.height,
          width: b.width * PAGE.width,
          height: b.height * PAGE.height,
        },
        crop,
      );
      ctx.drawImage(im, r.x, r.y, r.width, r.height);
    }
    // Uniformly scale the original composition; characters and lettering never shear.
    const scale = Math.min(box.width / 720, box.height / 1030);
    const x = 0,
      y = 0;
    ctx.translate(
      box.x + (box.width - 720 * scale) / 2,
      box.y + (box.height - 1030 * scale) / 2,
    );
    ctx.scale(scale, scale);
    if (!p) {
      ctx.fillStyle = '#777';
      ctx.font = '30px sans-serif';
      ctx.fillText('未割当', 30, 50);
      ctx.restore();
      continue;
    }
    if (!p.image && !draft) throw Error(`未作画のコマ: ${p.id}`);
    if (p.image) {
      const fit = containRect(image.width, image.height, 716, 716);
      if (layer !== 'overlay' && !crop)
        ctx.drawImage(
          image,
          x + 2 + fit.x,
          y + 2 + fit.y,
          fit.width,
          fit.height,
        );
    } else {
      ctx.fillStyle = '#f2f0eb';
      ctx.fillRect(2, 2, 716, 716);
      ctx.fillStyle = '#777';
      ctx.font = '30px sans-serif';
      ctx.fillText('未作画', 30, 50);
    }
    if (scale * 14 < 6)
      throw Error(`コマ ${p.id} の文字が小さすぎます。枠を広げてください`);
    if (layer === 'art') {
      ctx.restore();
      continue;
    }
    const snapshot = snapshots.find((s) => s.id === p.snapshotId);
    const localization =
      locale === 'en'
        ? localizations.find(
            (item) => item.locale === 'en' && item.snapshot_id === p.snapshotId,
          )
        : null;
    if (locale === 'en' && !localization)
      throw Error('現在の原作に対応する英訳がありません');
    if (!resolveText.has(snapshot))
      resolveText.set(snapshot, createTextResolver(snapshot, localization));
    const textForUnits = resolveText.get(snapshot);
    const text = textForUnits(p.unitIds);
    if (p.lettering?.mode === 'balloons') {
      const layout = validateLettering(p, p.lettering);
      for (const box of layout.boxes) {
        const unitText = textForUnits([box.unit_id]);
        drawLettering(
          ctx,
          unitText,
          {
            x: x + 2 + box.x * 716,
            y: y + 2 + box.y * 716,
            width: box.width * 716,
            height: box.height * 716,
          },
          true,
          box,
        );
      }
    } else
      drawLettering(
        ctx,
        text,
        { x: x + 10, y: y + 736, width: 700, height: 280 },
        false,
      );
    ctx.restore();
    // The frame stays above the artwork, including full-bleed crops.
    if (crop && layer === 'complete') {
      ctx.beginPath();
      slot.points.forEach(([x, y], i) =>
        i
          ? ctx.lineTo(x * PAGE.width, y * PAGE.height)
          : ctx.moveTo(x * PAGE.width, y * PAGE.height),
      );
      ctx.closePath();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  }
  return canvas.toDataURL('image/png');
}
export const pagePNG = (
  panels,
  snapshots,
  localizations = [],
  locale = 'ja',
  page = null,
  draft = false,
  imageCrops = {},
) =>
  pageLayers(
    panels,
    snapshots,
    localizations,
    locale,
    'complete',
    page,
    draft,
    imageCrops,
  );
// Legacy Live Manga v1 geometry; non-legacy layouts are rejected before this path.
export function panelLayout(i, width, height) {
  const x = i % 2 === 0 ? 820 : 60,
    y = 60 + Math.floor(i / 2) * 1080;
  const fit = containRect(width, height, 716, 716);
  return {
    frame: { x, y, width: 720, height: 1030 },
    artRect: {
      x: x + 2 + fit.x,
      y: y + 2 + fit.y,
      width: fit.width,
      height: fit.height,
    },
  };
}
