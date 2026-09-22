import {textForRefs} from './source-refs.js';
import {
  initialLayout,
  validateLayout,
  layoutWarnings,
  contentBox,
  PAGE,
  artPoints,
  overflowDrawOrder,
} from './layout.js';
import { panelArtRect } from './page-art.js';
import { wrapText, verticalColumns, letteringFont, validateLettering, letteringKind, isCustomLetteringBox } from './lettering.js';
import { panelHasText } from './core.js';
import { createTextResolver } from './localization.js';
import { imageOf } from './canvas-image.js';
import { outputSize } from './output.js';
export function lines(ctx, text, width) {
  return wrapText(text, (value) => ctx.measureText(value).width, width);
}
const verticalImages = new Map();
let verticalImagePixels = 0;
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function drawVertical(ctx, columns, box, size, lineHeight, font) {
  const transform = ctx.getTransform();
  const scale = Math.max(1, Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d));
  const glyphs = columns.flatMap((column, col) => column.map((glyph, row) =>
    `<text x="${box.width - size / 2 - col * size * lineHeight}" y="${row * size}">${xml(glyph)}</text>`)).join('');
  // Native SVG text shaping supplies vertical Japanese glyphs. No HTML, external
  // fonts or assets are loaded; draw at the destination density, including export.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(box.width * scale)}" height="${Math.ceil(box.height * scale)}" viewBox="0 0 ${box.width} ${box.height}"><g font-family="${xml(font)}" font-size="${size}" fill="#111" style="writing-mode:vertical-rl;text-orientation:upright" dominant-baseline="central">${glyphs}</g></svg>`;
  let pending = verticalImages.get(svg)?.pending;
  if (!pending) {
    pending = imageOf(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const pixels = Math.ceil(box.width * scale) * Math.ceil(box.height * scale);
    // Keep a small preview cache; full-page high-resolution exports stay transient.
    if (pixels <= 4_000_000) {
      while (verticalImages.size >= 8 || verticalImagePixels + pixels > 8_000_000) {
        const oldest = verticalImages.keys().next().value;
        verticalImagePixels -= verticalImages.get(oldest).pixels;
        verticalImages.delete(oldest);
      }
      verticalImages.set(svg, {pending, pixels});
      verticalImagePixels += pixels;
      pending.catch(() => {
        if (verticalImages.get(svg)?.pending === pending) {
          verticalImagePixels -= pixels;
          verticalImages.delete(svg);
        }
      });
    }
  }
  ctx.drawImage(await pending, box.x, box.y, box.width, box.height);
}
export function drawLettering(ctx, text, box, balloon, style = {}) {
  const padding = style.padding ?? 12,
    lineHeight = style.lineHeight ?? 1.25,
    kind = letteringKind(style);
  const inset =
    kind === 'balloon' && style.shape === 'ellipse'
      ? Math.min(box.width, box.height) * 0.15
      : 0;
  const textBox = {
    x: box.x + inset,
    y: box.y + inset,
    width: box.width - inset * 2,
    height: box.height - inset * 2,
  };
  const vertical = style.writingMode === 'vertical-rl';
  let size = style.fontSize ?? 24,
    wrapped;
  const minimum = style.fontSize ?? 14;
  for (; size >= minimum; size--) {
    ctx.font = `${size}px ${letteringFont(style)}`;
    if (vertical) {
      const capacity = Math.floor((textBox.height - padding * 2) / size);
      if (capacity < 1) continue;
      wrapped = verticalColumns(text, capacity);
      if ((wrapped.length - 1) * size * lineHeight + size <= textBox.width - padding * 2) break;
      continue;
    }
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
  if (balloon && (kind === 'balloon' || kind === 'narration')) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    if (kind === 'balloon' && style.tail) {
      ctx.beginPath();
      ctx.moveTo(box.x + box.width * 0.4, box.y + box.height * 0.5);
      ctx.lineTo(style.tailPoint?.[0] ?? 2 + style.tail[0] * 716, style.tailPoint?.[1] ?? 2 + style.tail[1] * 716);
      ctx.lineTo(box.x + box.width * 0.6, box.y + box.height * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    if (kind === 'narration' || style.shape === 'rect')
      ctx.rect(box.x, box.y, box.width, box.height);
    else if (style.shape === 'ellipse')
      ctx.ellipse(
        box.x + box.width / 2,
        box.y + box.height / 2,
        box.width / 2,
        box.height / 2,
        0,
        0,
        Math.PI * 2,
      );
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
  if (vertical) return drawVertical(ctx, wrapped, {x:textBox.x+padding,y:textBox.y+padding,width:textBox.width-padding*2,height:textBox.height-padding*2}, size, lineHeight, letteringFont(style));
  wrapped.forEach((line, i) =>
    ctx.fillText(
      line,
      textBox.x + padding,
      textBox.y + padding + i * size * lineHeight,
    ),
  );
}
function addQuad(ctx,points) {
  points.forEach(([x,y],i)=>i?ctx.lineTo(x*PAGE.width,y*PAGE.height):ctx.moveTo(x*PAGE.width,y*PAGE.height));
  ctx.closePath();
}
function strokeFrame(ctx,points) {
  ctx.beginPath();
  addQuad(ctx,points);
  ctx.strokeStyle='#111';ctx.lineWidth=4;ctx.stroke();
}
function clipQuad(ctx,points) {
  ctx.beginPath();
  addQuad(ctx,points);
  ctx.clip();
}
function clipOverflowExtension(ctx,slot) {
  ctx.beginPath();
  addQuad(ctx,slot.overflow.points);
  addQuad(ctx,slot.points);
  ctx.clip('evenodd');
}
function drawArt(ctx,slot,image,crop,layer) {
  if (image && layer !== 'overlay') {
    const r = panelArtRect(artPoints(slot),image.width,image.height,crop);
    ctx.drawImage(image,r.x,r.y,r.width,r.height);
  }
}
function enterComposition(ctx,slot) {
  const box = contentBox(slot.points);
  const scale = Math.min(box.width / 720, box.height / 1030);
  ctx.translate(
    box.x + (box.width - 720 * scale) / 2,
    box.y + (box.height - 1030 * scale) / 2,
  );
  ctx.scale(scale, scale);
  return scale;
}
export async function drawNameLettering(ctx,p,slot,snapshots,localizations,locale) {
  if(!panelHasText(p))return;
  const frame=contentBox(slot.points),layout=validateLettering(p,p.lettering);
  if(layout.mode!=='balloons')throw Error(`コマ ${p.id} の掲載文字を枠内に配置してください。全文captionへは戻しません`);
  for(const [index,box] of layout.boxes.entries()) {
    if((box.fontSize??48)<32)throw Error(`コマ ${p.id} の文字が小さすぎます。枠・ページを見直してください`);
    for(const other of layout.boxes.slice(index+1))if(box.x<other.x+other.width&&box.x+box.width>other.x&&box.y<other.y+other.height&&box.y+box.height>other.y)throw Error(`コマ ${p.id} の文字枠が重なっています`);
    const text=isCustomLetteringBox(box)?box.text:textForRefs(box.sourceRefs,snapshots,locale==='en'?localizations:null);
    await drawLettering(ctx,text,{x:frame.x+box.x*frame.width,y:frame.y+box.y*frame.height,width:box.width*frame.width,height:box.height*frame.height},true,{...box,fontSize:box.fontSize??48,tailPoint:box.tail?[frame.x+box.tail[0]*frame.width,frame.y+box.tail[1]*frame.height]:null});
  }
}
async function drawSlotLettering(ctx,p,slot,snapshots,localizations,locale,draft,resolveText) {
  if(p.namePlanVersion===2)return drawNameLettering(ctx,p,slot,snapshots,localizations,locale);
  const box = contentBox(slot.points);
  const scale = Math.min(box.width / 720, box.height / 1030);
  if (panelHasText(p) && !(draft && p.previewLetteringPending) && scale * 14 < 6)
    throw Error(`コマ ${p.id} の文字が小さすぎます。枠を広げてください`);
  if (!panelHasText(p) || (draft && p.previewLetteringPending)) return;
  ctx.save();
  try {
  enterComposition(ctx,slot);
  const x = 0, y = 0;
  const layout = p.lettering?.mode === 'balloons' ? validateLettering(p, p.lettering) : null;
  const needsSource = layout ? layout.boxes.some(box => !isCustomLetteringBox(box)) : true;
  const snapshot = snapshots.find((s) => s.id === p.snapshotId);
  const localization =
    locale === 'en'
      ? localizations.find(
          (item) => item.locale === 'en' && item.snapshot_id === p.snapshotId,
        )
      : null;
  if (needsSource && locale === 'en' && !p.sourceRefs && !localization)
    throw Error('現在の原作に対応する英訳がありません');
  if (needsSource && !p.sourceRefs && !resolveText.has(snapshot))
    resolveText.set(snapshot, createTextResolver(snapshot, localization));
  const textForUnits = needsSource && !p.sourceRefs ? resolveText.get(snapshot) : null;
  const text = layout
    ? null
    : p.sourceRefs
      ? textForRefs((p.lettering?.boxes?.flatMap(b=>b.sourceRefs??[])??[]).length?p.lettering.boxes.flatMap(b=>b.sourceRefs??[]):p.sourceRefs,snapshots,locale==='en'?localizations:null)
      : textForUnits(p.unitIds);
  if (layout) {
    for (const box of layout.boxes) {
      const unitText = isCustomLetteringBox(box)
        ? box.text
        : box.sourceRefs
          ? textForRefs(box.sourceRefs,snapshots,locale==='en'?localizations:null)
          : textForUnits([box.unit_id]);
      await drawLettering(
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
    await drawLettering(
      ctx,
      text,
      { x: x + 10, y: y + 736, width: 700, height: 280 },
      false,
    );
  } finally {
    ctx.restore();
  }
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
  output = {},
) {
  page ??= initialLayout(panels).pages[0] ?? { id: 'empty', slots: [] };
  validateLayout({ version: 1, pages: [page] }, panels);
  if (!draft) {
    const warnings = layoutWarnings({ version: 1, pages: [page] }, panels);
    if (warnings.length) throw Error(warnings.join(' / '));
  }
  const canvas = document.createElement('canvas');
  const size = outputSize(output);
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  ctx.scale(size.width / PAGE.width, size.height / PAGE.height);
  if (layer !== 'overlay') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1600, 2260);
  }
  const resolveText = new Map();
  const prepared = [];
  for (const slot of page.slots) {
    const p = panels.find((p) => p.id === slot.panelId);
    if (!p && !draft) throw Error('未割当の枠があります');
    if (p && !p.image && !draft) throw Error(`未作画のコマ: ${p.id}`);
    prepared.push({
      slot,
      p,
      image: p?.image ? await imageOf(p.image) : null,
      crop: p && imageCrops[p.id],
    });
  }
  for (const {slot,p,image,crop} of prepared) {
    ctx.save();
    clipQuad(ctx,slot.points);
    drawArt(ctx,slot,image,crop,layer);
    if (!p) {
      ctx.save();
      enterComposition(ctx,slot);
      ctx.fillStyle = '#777';
      ctx.font = '30px sans-serif';
      ctx.fillText('未割当', 30, 50);
      ctx.restore();
      ctx.restore();
      if (layer !== 'art') strokeFrame(ctx,slot.points);
      continue;
    }
    if (!p.image && p.namePlanVersion===2) {
      const frame=contentBox(slot.points);
      ctx.fillStyle='#f6f5f1';ctx.fillRect(frame.x,frame.y,frame.width,frame.height);
      ctx.fillStyle='#777';ctx.font='22px sans-serif';
      const intent=lines(ctx,`仮ネーム · ${p.nameIntent??p.id}`,Math.max(1,frame.width-32));
      intent.slice(0,3).forEach((line,i)=>ctx.fillText(line,frame.x+16,frame.y+frame.height-70+i*24));
    } else if (!p.image) {
      ctx.save();
      enterComposition(ctx,slot);
      ctx.fillStyle = '#f2f0eb';
      ctx.fillRect(2, 2, 716, 716);
      ctx.fillStyle = '#777';
      ctx.font = '30px sans-serif';
      ctx.fillText('未作画 · 原稿', 30, 50);
      if (p.sourceRefs?.length) {
        ctx.font = '24px sans-serif';
        const preview = lines(ctx, textForRefs(p.sourceRefs, snapshots), 650);
        preview.slice(0, 18).forEach((line, i) => ctx.fillText(line, 30, 105 + i * 30));
        if (preview.length > 18) ctx.fillText('… 全文は原稿割当で確認', 30, 675);
      }
      ctx.restore();
    }
    if (layer !== 'art' && !(!p.image && draft && p.sourceRefs?.length && p.namePlanVersion!==2)) await drawSlotLettering(ctx,p,slot,snapshots,localizations,locale,draft,resolveText);
    ctx.restore();
    if (layer !== 'art') strokeFrame(ctx,slot.points);
  }
  if (layer !== 'overlay') {
    for (const {slot} of overflowDrawOrder(page)) {
      const row = prepared.find((item) => item.slot.id === slot.id);
      ctx.save();
      clipOverflowExtension(ctx,slot);
      drawArt(ctx,slot,row.image,row.crop,layer);
      ctx.restore();
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
  output = {},
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
    output,
  );
