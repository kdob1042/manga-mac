import { COMPILER_VERSION, fail, canonical, treeLeaves, LIMITS, planSchema, validateSchema } from './schema.mjs';
export const PAGE_PROFILE = Object.freeze({ width: 1600, height: 2260, margin: 60, gutter: 28, minWidth: 128, minHeight: 110 });
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
export function validQuad(points) { return Array.isArray(points) && points.length === 4 && points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) && points.every((p, i) => Math.hypot(p[0] - points[(i + 1) % 4][0], p[1] - points[(i + 1) % 4][1]) >= .005 && cross(p, points[(i + 1) % 4], points[(i + 2) % 4]) > .00001); }
export function overlaps(a, b) {
  return ![a, b].some(poly => poly.some((p, i) => {
    const q = poly[(i + 1) % 4], axis = [-(q[1] - p[1]), q[0] - p[0]], project = v => v[0] * axis[0] + v[1] * axis[1];
    const aa = a.map(project), bb = b.map(project);
    return Math.max(...aa) <= Math.min(...bb) + 1e-9 || Math.max(...bb) <= Math.min(...aa) + 1e-9;
  }));
}
function allocate(total, weights, minima, path, diagnostics) {
  if (minima.reduce((sum, n) => sum + n, 0) > total + 1e-7) fail('infeasible', '文字・コマの最小領域が収まりません。ページ分割または段組みを変更してください', path, { available: total, required: minima.reduce((a, b) => a + b, 0) });
  const values = Array(weights.length).fill(null); let pending = weights.map((_, i) => i), remain = total;
  while (pending.length) {
    const sum = pending.reduce((n, i) => n + weights[i], 0);
    const limited = pending.filter(i => remain * weights[i] / sum < minima[i] - 1e-8);
    if (!limited.length) { pending.forEach(i => { values[i] = remain * weights[i] / sum; }); break; }
    for (const i of limited) { values[i] = minima[i]; remain -= minima[i]; }
    pending = pending.filter(i => !limited.includes(i));
  }
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  values.forEach((value, i) => { if (Math.abs(value / total - weights[i] / sumWeights) > .001) diagnostics.push({ code: 'weight_adjusted', path, child: i, requested: weights[i] / sumWeights, realized: value / total, reason: '最小領域を優先しました' }); });
  return values;
}
export function compileNameLayout(plan, profile = PAGE_PROFILE, textMetrics = {}, locks = {}) {
  validateSchema(plan, planSchema);
  const config = { ...PAGE_PROFILE, ...profile }, { width: W, height: H, margin: M, gutter: G } = config;
  if (Object.keys(config).some(key => !Object.hasOwn(PAGE_PROFILE, key)) || Object.values(config).some(n => !Number.isFinite(n) || n < 0) || W < 256 || H < 256 || W > 16384 || H > 16384 || M * 2 >= Math.min(W, H) || G < 2 || config.minWidth < 8 || config.minHeight < 8) fail('profile', 'ページ寸法・余白・溝が不正です');
  for (const page of plan.pages) {
    let count = 0;
    const check = (node, depth) => { if (++count > LIMITS.nodes || depth > LIMITS.depth) fail('tree_limit', 'ページ構造が複雑すぎます', page.id); if (node.type !== 'leaf') { if (node.children.length !== node.weights.length) fail('weights', '段組みの子と比率が一致しません', page.id); node.children.forEach(child => check(child, depth + 1)); } };
    check(page.tree, 0);
    if (treeLeaves(page.tree).length > LIMITS.pagePanels) fail('page_size', '1ページは1〜16コマです', page.id);
  }
  const diagnostics = [], round = n => Math.round(n * 1e10) / 1e10;
  const norm = points => points.map(([x, y]) => [round(x / W), round(y / H)]);
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const minSize = node => {
    if (node.type === 'leaf') {
      const metric = textMetrics[node.panelId] ?? {};
      for (const key of ['minWidth', 'minHeight']) if (metric[key] !== undefined && (!Number.isFinite(metric[key]) || metric[key] < 0)) fail('text_metrics', '文字領域の計測値が不正です', node.panelId);
      return [Math.max(config.minWidth, metric.minWidth ?? 0), Math.max(config.minHeight, metric.minHeight ?? 0)];
    }
    const sizes = node.children.map(minSize), row = node.type === 'row';
    return row ? [sizes.reduce((sum, size) => sum + size[0], 0) + G * (sizes.length - 1), Math.max(...sizes.map(size => size[1]))] : [Math.max(...sizes.map(size => size[0])), sizes.reduce((sum, size) => sum + size[1], 0) + G * (sizes.length - 1)];
  };
  const pages = plan.pages.map(page => {
    const slots = []; let nodes = 0;
    const visit = (node, x, y, w, h, path, depth = 0) => {
      if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('tree_limit', 'ページ構造が複雑すぎます', page.id);
      const [minW, minH] = minSize(node);
      if (w + 1e-6 < minW || h + 1e-6 < minH) fail('infeasible', '最小領域が不足しています。対象ページの構成を変更してください', path, { width: w, height: h, minWidth: minW, minHeight: minH });
      if (node.type === 'leaf') { slots.push({ id: `name:${page.id}:${node.panelId}`, panelId: node.panelId, points: norm(rect(x, y, w, h)) }); return; }
      if (!['row', 'column'].includes(node.type) || !Array.isArray(node.children) || node.children.length < 2 || node.children.length > 16 || !Array.isArray(node.weights) || node.children.length !== node.weights.length || node.weights.some(n => !Number.isFinite(n) || n <= 0 || n > 1000)) fail('tree', '段組み・比率が不正です', path);
      const row = node.type === 'row', total = (row ? w : h) - G * (node.children.length - 1), sizes = node.children.map(minSize);
      const lengths = allocate(total, node.weights, sizes.map(size => size[row ? 0 : 1]), path, diagnostics);
      if (node.slant) {
        if (!Number.isFinite(node.slant) || Math.abs(node.slant) > .2 || node.children.length !== 2 || node.children.some(child => child.type !== 'leaf')) fail('unsupported_slant', '斜め境界は隣接する2コマに指定してください', path);
        const d = node.slant * (row ? w : h), half = G / 2;
        if (lengths.some((length, i) => length - Math.abs(d) < sizes[i][row ? 0 : 1])) fail('infeasible_slant', '斜め境界で最小幅が不足します。傾きを小さくしてください', path);
        const b = row ? x + w - lengths[0] - half : y + lengths[0] + half;
        const polygons = row ? [
          [[b + half - d, y], [x + w, y], [x + w, y + h], [b + half + d, y + h]],
          [[x, y], [b - half - d, y], [b - half + d, y + h], [x, y + h]],
        ] : [
          [[x, y], [x + w, y], [x + w, b - half + d], [x, b - half - d]],
          [[x, b + half - d], [x + w, b + half + d], [x + w, y + h], [x, y + h]],
        ];
        node.children.forEach((child, i) => slots.push({ id: `name:${page.id}:${child.panelId}`, panelId: child.panelId, points: norm(polygons[i]) }));
        return;
      }
      let cursor = row ? x + w : y;
      node.children.forEach((child, i) => {
        const length = lengths[i];
        if (row) { visit(child, cursor - length, y, length, h, `${path}.${i}`, depth + 1); cursor -= length + G; }
        else { visit(child, x, cursor, w, length, `${path}.${i}`, depth + 1); cursor += length + G; }
      });
    };
    visit(page.tree, M, M, W - 2 * M, H - 2 * M, page.id);
    for (const slot of slots) {
      if (!validQuad(slot.points)) fail('geometry', '合法な凸四角形を生成できません', slot.panelId);
      if (locks.panelPoints?.[slot.panelId] && canonical(locks.panelPoints[slot.panelId]) !== canonical(slot.points)) fail('locked', '固定したコマの座標を変更する案です', slot.panelId);
    }
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) if (overlaps(slots[i].points, slots[j].points)) fail('overlap', 'コマが重なっています', page.id);
    if (canonical(slots.map(slot => slot.panelId)) !== canonical(treeLeaves(page.tree))) fail('order', '段組みの読み順が変わりました', page.id);
    if (locks.pages?.[page.id] && canonical(locks.pages[page.id]) !== canonical({ id: page.id, slots })) fail('locked', '固定ページを変更する案です', page.id);
    return { id: page.id, slots };
  });
  return { layout: { version: 1, pages, knownPanelIds: plan.panels.map(panel => panel.id) }, diagnostics, compilerVersion: COMPILER_VERSION, profile: config };
}
