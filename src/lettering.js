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
export const LETTERING_WRITING_MODES = ['horizontal-tb', 'vertical-rl'];
export const LETTERING_FONTS = ['gothic', 'mincho'];
export function letteringFont(style = {}) {
  if (style.fontFamily === 'mincho') return '"Hiragino Mincho ProN", "Yu Mincho", serif';
  if (style.fontFamily === 'gothic') return '"Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
  return 'sans-serif'; // Preserve the appearance of saved projects.
}

// Full-em upright cells; no ruby or horizontal-in-vertical number composition.
// Unlike horizontal hanging punctuation, a column must fit its finite height.
export function verticalColumns(text, capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) throw Error('縦書きの高さが足りません。文字枠を広げてください');
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  const columns = [];
  for (const paragraph of text.split('\n')) {
    const glyphs = [...segmenter.segment(paragraph)].map(item => item.segment);
    if (!glyphs.length) columns.push([]);
    for (let start = 0; start < glyphs.length;) {
      let end = Math.min(start + capacity, glyphs.length);
      if (end < glyphs.length) {
        while (end > start && (prohibitedStart.has(glyphs[end]) || prohibitedEnd.has(glyphs[end - 1]))) end--;
        if (end === start) throw Error('禁則を保って縦書きに収まりません。文字枠を広げてください');
      }
      columns.push(glyphs.slice(start, end));
      start = end;
    }
  }
  return columns;
}
export const LETTERING_KINDS = ['balloon', 'thought', 'narration', 'plain'];

export function letteringKind(box) {
  if (box?.kind === 'plain') return 'thought';
  if (box?.kind && LETTERING_KINDS.includes(box.kind)) return box.kind;
  if (box?.tail) return 'balloon';
  if (box?.shape === 'rect') return 'narration';
  return 'balloon';
}

export function defaultLettering(panel) {
  if(panel.requiredText)return {mode:'balloons',boxes:panel.requiredText.map((ref,i)=>({id:`box:${panel.id}:${i}`,sourceRefs:[ref],x:.55,y:.03+i*.9/Math.max(1,panel.requiredText.length),width:.42,height:Math.min(.28,.85/Math.max(1,panel.requiredText.length))}))};
  if(panel.sourceRefs)return {mode:'caption',boxes:panel.sourceRefs.map((ref,i)=>({id:`box:${panel.id}:${i}`,sourceRefs:[ref],x:.55,y:.03+i*.9/Math.max(1,panel.sourceRefs.length),width:.42,height:Math.min(.28,.85/Math.max(1,panel.sourceRefs.length))}))};
  const count = panel.unitIds.length;
  return { mode: 'caption', boxes: panel.unitIds.map((id, i) => ({ id: `letter:${id}`, unit_id: id, x: 0.55, y: 0.03 + i * 0.9 / Math.max(1, count), width: 0.42, height: Math.min(0.28, 0.85 / Math.max(1, count)) })) };
}
export function isCustomLetteringBox(box) {
  return box && box.unit_id === undefined && box.sourceRefs === undefined;
}

export function validateLettering(panel, layout) {
  const sourceRefsMode = Array.isArray(panel?.sourceRefs);
  const unitIds = Array.isArray(panel?.unitIds) ? panel.unitIds : [];
  if (!layout || !['caption', 'balloons'].includes(layout.mode) || !Array.isArray(layout.boxes) || (!sourceRefsMode && layout.boxes.filter(box => !isCustomLetteringBox(box)).length !== unitIds.length)) throw Error('文字配置が不正です');
  if (Object.keys(layout).some(k=>!['mode','boxes'].includes(k))) throw Error('文字配置の未対応項目です');
  const seen = new Set();
  for (const box of layout.boxes) {
    if (!box || typeof box !== 'object') throw Error('文字枠が不正です');
    const custom = isCustomLetteringBox(box);
    if (custom) {
      if (typeof box.id !== 'string' || !box.id.startsWith('custom:')) throw Error('追加文字枠IDが不正です');
      if (typeof box.text !== 'string' || !box.text.trim() || box.text.length > 4000) throw Error('追加文字枠の本文が不正です');
    } else if (box.text !== undefined) throw Error('原文文字枠の本文は変更できません');
    if (!custom && ((sourceRefsMode && (!box.id || !Array.isArray(box.sourceRefs))) || (!sourceRefsMode && !unitIds.includes(box.unit_id)))) throw Error('文字枠が不正、または原文の対応がありません');
    if (!custom && !sourceRefsMode && box.id !== undefined && box.id !== `letter:${box.unit_id}`) throw Error('文字枠IDは原文参照から変更できません');
    const key = custom ? `custom:${box.id}` : sourceRefsMode ? `ref:${box.id}` : `unit:${box.unit_id}`;
    if (seen.has(key) || [box.x, box.y, box.width, box.height].some(n => !Number.isFinite(n)) || box.x < 0 || box.y < 0 || box.width < .08 || box.height < .06 || box.x + box.width > 1.00001 || box.y + box.height > 1.00001) throw Error('文字枠がコマ外、または原文の対応が不正です');
    if (Object.keys(box).some(k => !['id','unit_id','sourceRefs','text','x','y','width','height','kind','shape','tail','fontSize','lineHeight','padding','locked','writingMode','fontFamily'].includes(k))) throw Error('文字枠の未対応項目です');
    if (box.writingMode !== undefined && !LETTERING_WRITING_MODES.includes(box.writingMode)) throw Error('未対応の文字方向です');
    if (box.fontFamily !== undefined && !LETTERING_FONTS.includes(box.fontFamily)) throw Error('未対応の書体です');
    if (box.kind !== undefined && !LETTERING_KINDS.includes(box.kind)) throw Error('未対応の文字枠種別です');
    if (box.shape !== undefined && !['round','rect','ellipse'].includes(box.shape)) throw Error('未対応の吹き出し形状です');
    if (box.kind === 'narration' && box.shape !== undefined && box.shape !== 'rect') throw Error('ナレーションの形状は四角形です');
    if ((box.kind === 'thought' || box.kind === 'narration') && box.tail !== undefined && box.tail !== null) throw Error('心中描写・ナレーションにはしっぽを付けられません');
    for (const [key,min,max] of [['fontSize',14,72],['lineHeight',1,2],['padding',0,40]]) if (box[key] !== undefined && (!Number.isFinite(box[key]) || box[key]<min || box[key]>max)) throw Error('文字スタイルの範囲が不正です');
    if (box.locked !== undefined && typeof box.locked !== 'boolean') throw Error('固定状態が不正です');
    if (box.tail !== undefined && box.tail !== null && (!Array.isArray(box.tail) || box.tail.length !== 2 || box.tail.some(n=>!Number.isFinite(n)||n<0||n>1))) throw Error('しっぽがコマ外です');
    seen.add(key);
  }
  if (!sourceRefsMode) {
    const sourceOrder = layout.boxes.filter(box => !isCustomLetteringBox(box)).map(box => box.unit_id);
    if (JSON.stringify(sourceOrder) !== JSON.stringify(unitIds)) throw Error('台詞の順序は変更できません');
  }
  return layout;
}

export function setLettering(project, panelId, layout) {
  const panel = project.panels.find(p => p.id === panelId);
  if (!panel) throw Error('コマが見つかりません');
  validateLettering(panel, layout);
  if(panel.sourceRefs){
    const identity=boxes=>boxes.filter(b=>!isCustomLetteringBox(b)).map(b=>({id:b.id,sourceRefs:b.sourceRefs}));
    if(JSON.stringify(identity(layout.boxes))!==JSON.stringify(identity((panel.lettering??defaultLettering(panel)).boxes)))throw Error('文字配置だけの編集で原文対応は変更できません');
  }
  const panels = project.panels.map(p => p.id === panelId ? { ...p, lettering: structuredClone(layout), ...(p.namePlanVersion===2?{letteringStatus:'ready',letteringArtworkRevision:p.artwork_revision??null}:{}) } : p);
  return { ...project, history: [...project.history, { panels: project.panels, layout: project.layout, ...(project.sourceApplication?{sourceApplication:project.sourceApplication}:{}), edit: true, after: {panels,layout:project.layout}, label: '文字配置', at: new Date().toISOString() }], panels, editRedo: [] };
}
