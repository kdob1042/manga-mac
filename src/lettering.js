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
  if(panel.sourceRefs)return {mode:'caption',boxes:panel.sourceRefs.map((ref,i)=>({id:`box:${panel.id}:${i}`,sourceRefs:[ref],x:.55,y:.03+i*.9/Math.max(1,panel.sourceRefs.length),width:.42,height:Math.min(.28,.85/Math.max(1,panel.sourceRefs.length))}))};
  const count = panel.unitIds.length;
  return { mode: 'caption', boxes: panel.unitIds.map((id, i) => ({ id: `letter:${id}`, unit_id: id, x: 0.55, y: 0.03 + i * 0.9 / Math.max(1, count), width: 0.42, height: Math.min(0.28, 0.85 / Math.max(1, count)) })) };
}
export function validateLettering(panel, layout) {
  if (!layout || !['caption', 'balloons'].includes(layout.mode) || !Array.isArray(layout.boxes) || (!panel.sourceRefs && layout.boxes.length !== panel.unitIds.length)) throw Error('文字配置が不正です');
  if (Object.keys(layout).some(k=>!['mode','boxes'].includes(k))) throw Error('文字配置の未対応項目です');
  const seen = new Set();
  for (const box of layout.boxes) {
    if ((!panel.sourceRefs&&!panel.unitIds.includes(box.unit_id)) || (panel.sourceRefs&&(!box.id||!Array.isArray(box.sourceRefs))) || seen.has(panel.sourceRefs?box.id:box.unit_id) || [box.x, box.y, box.width, box.height].some(n => !Number.isFinite(n)) || box.x < 0 || box.y < 0 || box.width < .08 || box.height < .06 || box.x + box.width > 1.00001 || box.y + box.height > 1.00001) throw Error('文字枠がコマ外、または原文の対応が不正です');
    if (!panel.sourceRefs && box.id !== undefined && box.id !== `letter:${box.unit_id}`) throw Error('文字枠IDは原文参照から変更できません');
    if (Object.keys(box).some(k => !['id','unit_id','sourceRefs','x','y','width','height','shape','tail','fontSize','lineHeight','padding','locked'].includes(k))) throw Error('文字枠の未対応項目です');
    if (box.shape !== undefined && !['round','rect','ellipse'].includes(box.shape)) throw Error('未対応の吹き出し形状です');
    for (const [key,min,max] of [['fontSize',14,72],['lineHeight',1,2],['padding',0,40]]) if (box[key] !== undefined && (!Number.isFinite(box[key]) || box[key]<min || box[key]>max)) throw Error('文字スタイルの範囲が不正です');
    if (box.locked !== undefined && typeof box.locked !== 'boolean') throw Error('固定状態が不正です');
    if (box.tail !== undefined && box.tail !== null && (!Array.isArray(box.tail) || box.tail.length !== 2 || box.tail.some(n=>!Number.isFinite(n)||n<0||n>1))) throw Error('しっぽがコマ外です');
    seen.add(panel.sourceRefs?box.id:box.unit_id);
  }
  if (!panel.sourceRefs && layout.boxes.some((b, i) => b.unit_id !== panel.unitIds[i])) throw Error('台詞の順序は変更できません');
  return layout;
}
export function setLettering(project, panelId, layout) {
  const panel = project.panels.find(p => p.id === panelId);
  if (!panel) throw Error('コマが見つかりません');
  validateLettering(panel, layout);
  if(panel.sourceRefs){
    const identity=boxes=>boxes.map(b=>({id:b.id,sourceRefs:b.sourceRefs}));
    if(JSON.stringify(identity(layout.boxes))!==JSON.stringify(identity((panel.lettering??defaultLettering(panel)).boxes)))throw Error('文字配置だけの編集で原文対応は変更できません');
  }
  const panels = project.panels.map(p => p.id === panelId ? { ...p, lettering: structuredClone(layout) } : p);
  return { ...project, history: [...project.history, { panels: project.panels, layout: project.layout, ...(project.sourceApplication?{sourceApplication:project.sourceApplication}:{}), edit: true, after: {panels,layout:project.layout}, label: '文字配置', at: new Date().toISOString() }], panels, editRedo: [] };
}
