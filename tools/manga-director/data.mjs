import { createHash } from 'node:crypto';
import { codePointMap, sourceResolver } from '../../src/source-refs.js';

export class DirectorError extends Error {
  constructor(code) { super(code); this.name = 'DirectorError'; this.code = code; }
}
export const check = (condition, code) => { if (!condition) throw new DirectorError(code); };
export const sha256 = text => createHash('sha256').update(text).digest('hex');

// The Director owns this envelope, NOT a second name-plan schema.
export function canonical(value, depth = 0) {
  check(depth <= 40, 'PAYLOAD_DEPTH');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { check(value.isWellFormed(), 'INVALID_UNICODE'); return JSON.stringify(value); }
  if (typeof value === 'number') { check(Number.isFinite(value), 'INVALID_NUMBER'); return JSON.stringify(value); }
  check(typeof value === 'object' && value !== null, 'NON_JSON_VALUE');
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(',')}]`;
  check([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'NON_JSON_OBJECT');
  return `{${Object.keys(value).sort().map(key => {
    check(!['__proto__', 'prototype', 'constructor'].includes(key), 'UNSAFE_KEY');
    return `${canonical(key)}:${canonical(value[key], depth + 1)}`;
  }).join(',')}}`;
}
export function copy(value) {
  const json = canonical(value);
  check(Buffer.byteLength(json) <= 8 * 1024 * 1024, 'PAYLOAD_LIMIT');
  return JSON.parse(json);
}
export const digest = value => sha256(canonical(value));
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
export function keys(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
  check(required.every(k => Object.hasOwn(value, k)), 'MISSING_FIELD');
  check(Object.keys(value).every(k => [...required, ...optional].includes(k)), 'UNKNOWN_FIELD');
}
export function text(value, max = 16000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max && value.isWellFormed(), 'INVALID_TEXT');
}
export function ids(list, { empty = false } = {}) {
  check(Array.isArray(list) && list.length <= 10000 && (empty || list.length > 0), 'INVALID_IDS');
  list.forEach(id => text(id, 256));
  check(new Set(list).size === list.length, 'DUPLICATE_ID');
}
export function prepareInput(raw) {
  const input = copy(raw);
  keys(input, ['snapshot'], ['selectedSceneIds', 'context']);
  const s = input.snapshot;
  check(s && Array.isArray(s.scenes) && s.scenes.length > 0 && s.scenes.length <= 1000, 'INVALID_SNAPSHOT');
  text(s.id, 256); text(s.workId, 256);
  ids(s.scenes.map(scene => scene.id));
  s.scenes.forEach(scene => codePointMap(scene.text));
  sourceResolver([s]);
  input.selectedSceneIds ??= s.scenes.map(scene => scene.id);
  ids(input.selectedSceneIds);
  check(input.selectedSceneIds.every(id => s.scenes.some(scene => scene.id === id)), 'INVALID_SELECTION');
  input.context ??= {};
  return freeze(input);
}

export function validateReview(raw, snapshot, selection, planIndex) {
  const r = copy(raw), allowed = new Set(selection), resolve = sourceResolver([snapshot]);
  keys(r, ['issues', 'suggestions']);
  check(Array.isArray(r.issues) && r.issues.length <= 100 && Array.isArray(r.suggestions) && r.suggestions.length <= 100, 'REVIEW_LIMIT');
  ids(r.issues.map(i => i.key), { empty: true });
  for (const issue of r.issues) {
    keys(issue, ['key', 'severity', 'detail']); text(issue.detail);
    check(['major', 'minor'].includes(issue.severity), 'INVALID_SEVERITY');
  }
  ids(r.suggestions.map(s => s.id), { empty: true });
  const validateRef = ref => {
    keys(ref, ['snapshotId', 'sceneId', 'startCp', 'endCp']);
    check(allowed.has(ref.sceneId), 'OUTSIDE_SELECTION');
    try { return resolve(ref); } catch { throw new DirectorError('STALE_SOURCE_REF'); }
  };
  for (const s of r.suggestions) {
    const common = ['id', 'issueKey', 'kind', 'reason', 'effect', 'benefit', 'impact'];
    check(['direction_only', 'script_change'].includes(s.kind), 'INVALID_SUGGESTION_KIND');
    keys(s, [...common, ...(s.kind === 'direction_only' ? ['sourceRefs', 'instruction'] : ['edits'])]);
    check(r.issues.some(i => i.key === s.issueKey), 'UNKNOWN_ISSUE_KEY');
    text(s.reason); text(s.effect);
    check(Number.isFinite(s.benefit) && s.benefit >= 0 && s.benefit <= 1, 'INVALID_BENEFIT');
    keys(s.impact, ['pageIds', 'panelIds', 'deltaPages', 'deltaPanels']);
    for (const key of ['pageIds', 'panelIds']) {
      ids(s.impact[key]);
      check(s.impact[key].every(id => planIndex[key].includes(id)), 'UNKNOWN_PLAN_TARGET');
    }
    for (const key of ['deltaPages', 'deltaPanels']) check(Number.isSafeInteger(s.impact[key]) && Math.abs(s.impact[key]) <= 1000, 'INVALID_IMPACT');
    if (s.kind === 'direction_only') {
      text(s.instruction);
      check(Array.isArray(s.sourceRefs) && s.sourceRefs.length > 0 && s.sourceRefs.length <= 100, 'INVALID_SOURCE_REFS');
      s.sourceRefs.forEach(validateRef);
    } else {
      check(Array.isArray(s.edits) && s.edits.length > 0 && s.edits.length <= 100, 'INVALID_EDITS');
      for (const edit of s.edits) {
        keys(edit, ['op', 'ref', 'expectedText', 'text']);
        check(['insert_before', 'insert_after', 'replace', 'delete'].includes(edit.op), 'INVALID_EDIT_OPERATION');
        check(validateRef(edit.ref) === edit.expectedText, 'SOURCE_TEXT_MISMATCH');
        if (edit.op === 'delete') check(edit.text === '', 'INVALID_DELETE'); else text(edit.text);
        check(edit.op !== 'replace' || edit.text !== edit.expectedText, 'NO_OP_EDIT');
      }
    }
  }
  return freeze(r);
}

const normalize = value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
export function proposalFingerprint(s, snapshot) {
  const resolve = sourceResolver([snapshot]);
  // Exclude generated IDs, snapshot IDs, offsets and wording of the rationale.
  const changes = s.kind === 'script_change'
    ? s.edits.map(e => [e.op, e.ref.sceneId, normalize(e.expectedText), normalize(e.text)])
    : [normalize(s.instruction), s.sourceRefs.map(r => [r.sceneId, normalize(resolve(r))])];
  return digest([s.kind, changes]);
}

export function applyWorkingEdits(original, current, suggestions, maxAddedCp) {
  const edits = suggestions.filter(s => s.kind === 'script_change').flatMap(s => s.edits);
  if (!edits.length) return current;
  const byScene = new Map();
  for (const edit of edits) {
    const { startCp, endCp, sceneId } = edit.ref;
    const from = edit.op === 'insert_after' ? endCp : startCp;
    const to = edit.op.startsWith('insert_') ? from : endCp;
    if (!byScene.has(sceneId)) byScene.set(sceneId, []);
    byScene.get(sceneId).push({ from, to, value: edit.text });
  }
  const next = copy(current);
  for (const scene of next.scenes) {
    const changes = byScene.get(scene.id); if (!changes) continue;
    changes.sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 1; i < changes.length; i++) {
      const a = changes[i - 1], b = changes[i];
      check(b.from >= a.to && a.from !== b.from && !(a.from === a.to && a.from === b.to), 'OVERLAPPING_EDITS');
    }
    const map = codePointMap(scene.text);
    for (const e of [...changes].reverse()) scene.text = scene.text.slice(0, map[e.from]) + e.value + scene.text.slice(map[e.to]);
    check(scene.text.trim().length > 0, 'EMPTY_SCENE');
  }
  const growth = next.scenes.reduce((sum, s, i) => sum + Math.max(0, [...s.text].length - [...original.scenes[i].text].length), 0);
  check(growth <= maxAddedCp, 'TEXT_GROWTH_LIMIT');
  const content = next.scenes.map(s => [s.id, s.text]);
  next.id = `working:${digest([original.id, content]).slice(0, 40)}`;
  next.commit = null;
  next.directorProvenance = { kind: 'working', baseSnapshotId: original.id, baseCommit: original.commit ?? null };
  return freeze(next);
}

export function finalDiff(original, working) {
  return original.scenes.flatMap((before, i) => {
    const after = working.scenes[i];
    check(before.id === after.id, 'SCENE_ORDER_CHANGED');
    return before.text === after.text ? [] : [{ sceneId: before.id, path: before.path ?? null,
      beforeHash: sha256(before.text), afterHash: sha256(after.text), before: before.text, after: after.text }];
  });
}
