// Canvas uses the OS font/text engine; these functions only place source units.
const prohibitedStart = new Set([... '、。，．？！：；）］｝〉》」』】〕〗〙〛ーぁぃぅぇぉっゃゅょァィゥェォッャュョ']);
const prohibitedEnd = new Set([... '（［｛〈《「『【〔〖〘〚']);
export function wrapText(text, measure, width) {
  if (!Number.isFinite(width) || width <= 0) throw Error('文字枠の幅が不正です');
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const { segment } of segmenter.segment(paragraph)) {
      if (line && measure(line + segment) > width) {
        if (prohibitedStart.has(segment)) { line += segment; continue; }
        const glyphs = [...segmenter.segment(line)].map(s => s.segment);
        let carry = '';
        while (glyphs.length && prohibitedEnd.has(glyphs.at(-1))) carry = glyphs.pop() + carry;
        if (glyphs.length) lines.push(glyphs.join(''));
        line = carry;
      }
      line += segment;
    }
    lines.push(line);
  }
  return lines;
}
export function defaultLettering(panel) {
  const count = panel.unitIds.length;
  return { mode: 'caption', boxes: panel.unitIds.map((id, i) => ({ unit_id: id, x: 0.55, y: 0.03 + i * 0.9 / Math.max(1, count), width: 0.42, height: Math.min(0.28, 0.85 / Math.max(1, count)) })) };
}
export function validateLettering(panel, layout) {
  if (!layout || !['caption', 'balloons'].includes(layout.mode) || !Array.isArray(layout.boxes) || layout.boxes.length !== panel.unitIds.length) throw Error('文字配置が不正です');
  const seen = new Set();
  for (const box of layout.boxes) {
    if (!panel.unitIds.includes(box.unit_id) || seen.has(box.unit_id) || [box.x, box.y, box.width, box.height].some(n => !Number.isFinite(n)) || box.x < 0 || box.y < 0 || box.width < .08 || box.height < .06 || box.x + box.width > 1.00001 || box.y + box.height > 1.00001) throw Error('文字枠がコマ外、または原文の対応が不正です');
    seen.add(box.unit_id);
  }
  if (layout.boxes.some((b, i) => b.unit_id !== panel.unitIds[i])) throw Error('台詞の順序は変更できません');
  return layout;
}
export function setLettering(project, panelId, layout) {
  const panel = project.panels.find(p => p.id === panelId);
  if (!panel) throw Error('コマが見つかりません');
  validateLettering(panel, layout);
  return { ...project, history: [...project.history, { panels: project.panels, label: '文字配置', at: new Date().toISOString() }], panels: project.panels.map(p => p.id === panelId ? { ...p, lettering: structuredClone(layout) } : p) };
}
