import { fail, canonical, sha256, LIMITS } from './schema.mjs';
export const refKey = ref => canonical([ref.snapshotId, ref.sceneId, ref.startCp, ref.endCp]);
export const intersects = (a, b) => a.snapshotId === b.snapshotId && a.sceneId === b.sceneId && a.startCp < b.endCp && b.startCp < a.endCp;
export function resolveRef(snapshots, ref) {
  const scene = snapshots.find(snapshot => snapshot.id === ref.snapshotId)?.scenes.find(scene => scene.id === ref.sceneId);
  if (!scene || typeof scene.text !== 'string' || !scene.text.isWellFormed()) fail('source', '原稿の版・場面がありません');
  const chars = [...scene.text];
  if (!Number.isSafeInteger(ref.startCp) || !Number.isSafeInteger(ref.endCp) || ref.startCp < 0 || ref.startCp >= ref.endCp || ref.endCp > chars.length) fail('source_range', '原稿範囲が不正です');
  return chars.slice(ref.startCp, ref.endCp).join('');
}
export function orderedCoverage(expected, actual) {
  let i = 0, j = 0, a = expected[0]?.startCp, b = actual[0]?.startCp;
  while (i < expected.length && j < actual.length) {
    const e = expected[i], r = actual[j];
    if (e.snapshotId !== r.snapshotId || e.sceneId !== r.sceneId || a !== b) return false;
    const end = Math.min(e.endCp, r.endCp); a = end; b = end;
    if (end === e.endCp) { i++; a = expected[i]?.startCp; }
    if (end === r.endCp) { j++; b = actual[j]?.startCp; }
  }
  return i === expected.length && j === actual.length;
}
export function clipRefs(refs, target) {
  return refs.filter(ref => intersects(ref, target)).map(ref => ({ ...ref, startCp: Math.max(ref.startCp, target.startCp), endCp: Math.min(ref.endCp, target.endCp) }));
}
// The paragraph boundaries deliberately match the existing SourceSnapshot tokenizer.
export function sourceParagraphs(snapshot, sceneIds = snapshot.scenes.map(scene => scene.id)) {
  const result = [];
  for (const scene of snapshot.scenes.filter(scene => sceneIds.includes(scene.id))) {
    if (typeof scene.text !== 'string' || !scene.text.isWellFormed()) fail('unicode', '原稿のUnicodeが不正です');
    const positions = new Map([[0, 0]]); let utf16 = 0, cp = 0;
    for (const ch of scene.text) { utf16 += ch.length; positions.set(utf16, ++cp); }
    let start = 0, index = 0;
    const add = end => {
      const text = scene.text.slice(start, end);
      if (text.trim() && !/^\s*#/.test(text)) result.push({ id: `${scene.id}:u${index}`, text, source: { snapshotId: snapshot.id, sceneId: scene.id, startCp: positions.get(start), endCp: positions.get(end) } });
      index++;
    };
    for (const match of scene.text.matchAll(/\n\s*\n/g)) { add(match.index); start = match.index + match[0].length; }
    add(scene.text.length);
  }
  return result;
}
function narrativeParts(text) {
  const parts = []; let at = 0, start = 0;
  const addProse = (from, to) => {
    const value = text.slice(from, to); if (!value) return;
    for (const { segment } of new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(value)) parts.push({ text: segment, kind: 'prose' });
  };
  while (at < text.length) {
    if (text[at] !== '「' && text[at] !== '『') { at++; continue; }
    const opens = { '「': '」', '『': '』' }, stack = [opens[text[at]]]; let end = at + 1;
    for (; end < text.length && stack.length; end++) {
      if (opens[text[end]]) stack.push(opens[text[end]]);
      else if (text[end] === stack.at(-1)) stack.pop();
    }
    if (stack.length) { at++; continue; }
    addProse(start, at); parts.push({ text: text.slice(at, end), kind: 'dialogue' }); start = end; at = end;
  }
  addProse(start, text.length); return parts;
}
function paragraphParts(text) {
  const parts = []; let at = 0;
  // Image alt/URL and markup are provenance, never automatically printed dialogue.
  const markup = /!\[[^\]]*\]\([^\n]*?\)|<!--[^]*?-->|\[([^\]]+)\]\(([^\s)]*)\)|(?:\*\*|__|`)/g;
  for (const match of text.matchAll(markup)) {
    parts.push(...narrativeParts(text.slice(at, match.index)));
    if (match[1] !== undefined) {
      parts.push({ text: '[', kind: 'reference' }, ...narrativeParts(match[1]), { text: match[0].slice(match[1].length + 1), kind: 'reference' });
    } else parts.push({ text: match[0], kind: 'reference' });
    at = match.index + match[0].length;
  }
  parts.push(...narrativeParts(text.slice(at)));
  // Keep whitespace mapped, but do not create empty printed boxes.
  return parts.map(part => part.text.trim() ? part : { ...part, kind: 'reference' });
}
export function atomize(snapshot, sceneIds) {
  const result = [];
  for (const paragraph of sourceParagraphs(snapshot, sceneIds)) {
    let offset = paragraph.source.startCp;
    const parts = paragraphParts(paragraph.text);
    if (parts.map(part => part.text).join('') !== paragraph.text) fail('atomizer', '原稿の分割で文字が変わりました');
    parts.forEach((part, index) => {
      const endCp = offset + [...part.text].length;
      result.push({ id: `${paragraph.id}:a${index}`, unitId: paragraph.id, kind: part.kind, text: part.text, source: { ...paragraph.source, startCp: offset, endCp } }); offset = endCp;
    });
    if (offset !== paragraph.source.endCp) fail('atomizer', '原稿の位置対応が不正です');
  }
  if (result.length > LIMITS.atoms) fail('source_limit', '選択原稿が大きすぎます。制作範囲を分けてください');
  return result;
}
export function selectAtoms(all, ids) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail('selection', '制作する原稿範囲を選んでください');
  const selected = all.filter(atom => ids.includes(atom.id));
  if (canonical(selected.map(atom => atom.id)) !== canonical(ids)) fail('selection', '原稿選択の欠落・重複・順序変更があります');
  return selected;
}
export async function sourceDescriptor(project, snapshot, atoms, contextAtomIds = []) {
  const contexts = contextAtomIds.length ? atomize(snapshot).filter(atom => contextAtomIds.includes(atom.id)) : [];
  const sceneIds = [...new Set([...atoms, ...contexts].map(atom => atom.source.sceneId))];
  const settingsHash = await sha256(snapshot.settings ?? []);
  const referenceIdentity = (project.characters ?? []).map(({ id, name, description, hash, sourceHash }) => ({ id, name: name ?? '', description: description ?? '', hash: hash ?? sourceHash ?? '' }));
  return {
    repo: snapshot.repo, workId: snapshot.workId ?? project.workId, branch: snapshot.sync?.source_branch ?? 'main', commit: snapshot.sha,
    scenes: await Promise.all(snapshot.scenes.filter(scene => sceneIds.includes(scene.id)).map(async scene => ({ id: scene.id, sha256: await sha256(scene.text) }))),
    selectedAtomIds: atoms.map(atom => atom.id), settingsHash, referencesHash: await sha256(referenceIdentity),
  };
}
export async function bindSource(file, project) {
  const snapshot = project.snapshots?.find(snapshot => snapshot.id === project.active);
  if (!snapshot || file.source.repo !== snapshot.repo || file.source.workId !== (snapshot.workId ?? project.workId)) fail('work', '同じ作品の原稿を先に取り込んでください');
  const ids = file.source.scenes.map(scene => scene.id);
  if (new Set(ids).size !== ids.length || canonical(snapshot.scenes.filter(scene => ids.includes(scene.id)).map(scene => scene.id)) !== canonical(ids)) fail('scene_order', '場面の欠落・重複・順序変更があります');
  for (const declared of file.source.scenes) {
    const scene = snapshot.scenes.find(scene => scene.id === declared.id);
    if (!scene || await sha256(scene.text) !== declared.sha256) fail('source_changed', `${declared.id}の原稿が変わっています`);
  }
  const all = atomize(snapshot, ids), atoms = selectAtoms(all, file.source.selectedAtomIds);
  const current = await sourceDescriptor(project, snapshot, atoms);
  if (current.settingsHash !== file.source.settingsHash || current.referencesHash !== file.source.referencesHash) fail('references_changed', '人物参照または設定が変わっています。再確認してネームを更新してください');
  return { snapshot, atoms, contextAtoms: all, descriptor: current };
}
export function requiredTextForSource(project, target) {
  const state = project.namePlan;
  if (state?.format !== 'manga-mac/name-plan/v2' || state.snapshotId !== project.active || state.status !== 'adopted') return [target];
  const policy = state.sourcePolicy ?? [];
  const clipped = policy.filter(entry => intersects(entry.source, target));
  const coverage = clipped.map(entry => ({ ...entry.source, startCp: Math.max(entry.source.startCp, target.startCp), endCp: Math.min(entry.source.endCp, target.endCp) }));
  if (!orderedCoverage([target], coverage)) return [target];
  return clipped.flatMap(entry => clipRefs(entry.requiredText, target));
}
