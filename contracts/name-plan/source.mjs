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
export function sourceCharacterIdentity(snapshot) {
  const references = new Map();
  for (const reference of snapshot.references ?? []) {
    const id = reference?.characterId ?? reference?.id;
    if (!id) continue;
    if (references.has(id)) fail('character', '人物参照IDが重複しています');
    references.set(id, reference);
  }
  const seen = new Set();
  return (snapshot.characters ?? []).map(character => {
    if (!character?.id || seen.has(character.id)) fail('character', '原稿の人物IDが不正または重複しています');
    seen.add(character.id);
    const reference = references.get(character.id);
    return {
      id: character.id,
      name: character.name ?? '',
      description: character.description ?? '',
      hash: reference?.hash ?? character.hash ?? character.sourceHash ?? '',
    };
  });
}
export const sourceCharacterIds = snapshot => sourceCharacterIdentity(snapshot).map(character => character.id);

export const hasEmbeddedSource = file => file?.source?.kind === 'embedded';
export const namePartKey = file => hasEmbeddedSource(file) ? canonical([file.source.repo, file.source.workId, file.source.episodeId, file.source.number]) : null;

export function embeddedSourceDescriptor(project, snapshot, atoms, plan, { episodeId, number = 1 } = {}) {
  const contextIds = new Set(plan.panels.flatMap(panel => panel.contextAtomIds));
  const included = [...atoms, ...atomize(snapshot).filter(atom => contextIds.has(atom.id))];
  const sceneIds = new Set(included.map(atom => atom.source.sceneId));
  const primaryEpisodes = new Set(atoms.map(atom => snapshot.scenes.find(scene => scene.id === atom.source.sceneId)?.episodeId ?? snapshot.episodeId));
  episodeId ??= primaryEpisodes.size === 1 ? [...primaryEpisodes][0] : null;
  if (!episodeId || [...primaryEpisodes].some(id => id && id !== episodeId)) fail('episode', '一つの話を選んでネームを作成してください');
  const used = new Set([...plan.panels.flatMap(panel => panel.characterIds), ...plan.coverage.map(entry => entry.speakerId).filter(Boolean)]);
  const characters = sourceCharacterIdentity(snapshot).filter(character => used.has(character.id)).map(({ id, name }) => ({ id, name }));
  return { kind: 'embedded', repo: snapshot.repo, workId: snapshot.workId ?? project.workId, episodeId, number,
    branch: snapshot.sync?.source_branch ?? 'dev', ...(/^[0-9a-f]{40}$/.test(snapshot.sha ?? '') ? { commit: snapshot.sha } : {}),
    scenes: snapshot.scenes.filter(scene => sceneIds.has(scene.id)).map(scene => ({ id: scene.id, episodeId: scene.episodeId ?? episodeId, text: scene.text })),
    selectedAtomIds: atoms.map(atom => atom.id), characters };
}

export async function bindEmbeddedSource(file, project = {}) {
  const source = file.source;
  const current = project.snapshots?.find(snapshot => snapshot.id === project.active);
  if ((project.workId && project.workId !== source.workId) || (current?.repo && current.repo !== source.repo)) fail('work', '別作品のネームは取り込めません');
  if (new Set(source.scenes.map(scene => scene.id)).size !== source.scenes.length) fail('scene_order', '保存原文の場面IDが重複しています');
  // This digest is only a local immutable snapshot key; it is never compared
  // with the latest manuscript, settings, or reference images.
  const snapshot = { id: `name-source:${await sha256(source)}`, repo: source.repo, workId: source.workId,
    sha: source.commit ?? '', episodeId: source.episodeId, episodeIds: [source.episodeId], embeddedName: true,
    scenes: structuredClone(source.scenes), characters: structuredClone(source.characters), settings: [], references: [],
    sync: { source_branch: source.branch }, manifest: { work: { title: file.title } } };
  const all = atomize(snapshot), atoms = selectAtoms(all, source.selectedAtomIds);
  if (atoms.some(atom => snapshot.scenes.find(scene => scene.id === atom.source.sceneId).episodeId !== source.episodeId)) fail('episode', '対象本文が指定話の外にあります');
  sourceCharacterIds(snapshot);
  return { snapshot, atoms, contextAtoms: all, descriptor: source };
}

export async function sourceDescriptor(project, snapshot, atoms, contextAtomIds = []) {
  const contexts = contextAtomIds.length ? atomize(snapshot).filter(atom => contextAtomIds.includes(atom.id)) : [];
  const sceneIds = [...new Set([...atoms, ...contexts].map(atom => atom.source.sceneId))];
  const settingsHash = await sha256(snapshot.settings ?? []);
  return {
    repo: snapshot.repo, workId: snapshot.workId ?? project.workId, branch: snapshot.sync?.source_branch ?? 'main', commit: snapshot.sha,
    scenes: await Promise.all(snapshot.scenes.filter(scene => sceneIds.includes(scene.id)).map(async scene => ({ id: scene.id, sha256: await sha256(scene.text) }))),
    selectedAtomIds: atoms.map(atom => atom.id), settingsHash, referencesHash: await sha256(sourceCharacterIdentity(snapshot)),
  };
}
export async function bindSource(file, project) {
  if (hasEmbeddedSource(file)) return bindEmbeddedSource(file, project);
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
  return { snapshot, atoms, contextAtoms: all, descriptor: current };
}
export function requiredTextForSource(project, target) {
  const state = [project.namePlan, ...(project.otherNamePlans ?? [])].find(state => state?.format === 'manga-mac/name-plan/v2' && state.snapshotId === target.snapshotId && state.status === 'adopted');
  if (!state) return [target];
  const policy = state.sourcePolicy ?? [];
  const clipped = policy.filter(entry => intersects(entry.source, target));
  const coverage = clipped.map(entry => ({ ...entry.source, startCp: Math.max(entry.source.startCp, target.startCp), endCp: Math.min(entry.source.endCp, target.endCp) }));
  if (!orderedCoverage([target], coverage)) return [target];
  return clipped.flatMap(entry => clipRefs(entry.requiredText, target));
}
