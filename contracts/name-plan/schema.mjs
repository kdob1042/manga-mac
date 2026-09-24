// One schema for model responses, imported files and deterministic validation.
export const FORMAT = 'manga-mac/name-plan/v2';
export const POLICY_VERSION = 'name-director/2.0.0';
export const COMPILER_VERSION = 'name-layout/2.0.0';
export const MAX_BYTES = 4 * 1024 * 1024;
export const LIMITS = Object.freeze({ panels: 2000, pages: 1000, pagePanels: 16, atoms: 12000, depth: 8, nodes: 63 });
const str = (maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength });
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$', maxLength: 160 };
const arr = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems, uniqueItems: false });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const PRESENTATIONS = ['dialogue', 'thought', 'narration', 'visual', 'reference'];
export const ROLES = ['splash', 'dominant', 'standard', 'reaction', 'sequence', 'inset'];
export const FUNCTIONS = ['setup', 'action', 'reveal', 'reaction', 'pause', 'payoff', 'transition'];
export const TEMPOS = ['fast', 'normal', 'slow', 'hold'];
const ids = (max = LIMITS.atoms) => arr(id, max);
const tree = {
  anyOf: [
    obj({ type: { const: 'leaf' }, panelId: id }),
    obj({ type: { enum: ['row', 'column'] }, children: arr({ $ref: '#/$defs/tree' }, 16, 2), weights: arr({ type: 'number', exclusiveMinimum: 0, maximum: 1000 }, 16, 2), slant: { type: 'number', minimum: -.2, maximum: .2 } }, ['type', 'children', 'weights']),
  ],
};
// Optional production guidance. Older name-plan/v2 files remain valid.
const continuity = obj({
  location: str(160), timeOfDay: str(80), storyIntent: str(500), previousPanelId: id,
  characters: arr(obj({ id, costume: str(200), visualState: str(200), emotion: str(200), holding: arr(str(100), 8) }, ['id']), 32),
  props: arr(str(120), 16), spatial: str(300), hardConstraints: arr(str(180), 12),
}, []);
export const planSchema = {
  ...obj({
    workGoal: obj({ readerQuestion: str(2000), emotionalArc: arr(str(300), 24, 1), payoff: str(2000) }),
    coverage: arr(obj({ atomId: id, presentation: { enum: PRESENTATIONS }, reason: str(1000), speakerId: { anyOf: [id, { type: 'null' }] } }, ['atomId', 'presentation', 'reason']), LIMITS.atoms, 1),
    beats: arr(obj({ id, atomIds: ids(), function: { enum: FUNCTIONS }, tempo: { enum: TEMPOS }, readerBefore: str(), readerAfter: str() }), LIMITS.atoms, 1),
    panels: arr(obj({ id, atomIds: ids(), contextAtomIds: ids(), beatIds: ids(), characterIds: ids(32), role: { enum: ROLES }, shot: { enum: ['wide', 'medium', 'close', 'detail', 'pov'] }, shotIntent: str(4000), prompt: str(20000), silentReason: { type: 'string', maxLength: 1000 }, protect: arr(str(120), 12), gaze: { enum: ['left', 'right', 'neutral'] }, continuity }, ['id', 'atomIds', 'contextAtomIds', 'beatIds', 'characterIds', 'role', 'shot', 'shotIntent', 'prompt', 'silentReason', 'protect', 'gaze']), LIMITS.panels, 1),
    pages: arr(obj({ id, purpose: str(), entryBeatId: id, exit: obj({ kind: { enum: ['hook', 'resolution', 'pause', 'transition'] }, note: str(), payoffBeatIds: ids(24) }), tree: { $ref: '#/$defs/tree' } }), LIMITS.pages, 1),
  }),
  $defs: { tree },
};
export const fileSchema = {
  ...obj({
    format: { const: FORMAT }, title: str(300), readingDirection: { const: 'rtl' }, stage: { const: 'name-only' },
    source: { anyOf: [obj({ repo: str(200), workId: id, branch: { enum: ['main', 'dev'] }, commit: { type: 'string', pattern: '^[0-9a-f]{40}$' },
      scenes: arr(obj({ id, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } }), 1000, 1), selectedAtomIds: ids(),
      settingsHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, referencesHash: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
      ['repo', 'workId', 'branch', 'scenes', 'selectedAtomIds', 'settingsHash', 'referencesHash']),
      obj({ kind: { const: 'embedded' }, repo: str(200), workId: id, episodeId: id,
        number: { type: 'integer', minimum: 1, maximum: 999999 },
        branch: { enum: ['main', 'dev'] }, commit: { type: 'string', pattern: '^[0-9a-f]{40}$' },
        scenes: arr(obj({ id, episodeId: id, text: str(MAX_BYTES) }), 1000, 1),
        selectedAtomIds: ids(), characters: arr(obj({ id, name: str(300) }), 2000),
      }, ['kind', 'repo', 'workId', 'episodeId', 'number', 'branch', 'scenes', 'selectedAtomIds', 'characters']),
    ] },
    policyVersion: str(100), provenance: obj({ producer: str(100), model: { type: 'string', maxLength: 200 }, editedBy: arr(str(100), 20) }),
    plan: planSchema,
  }), $defs: { tree },
};

export class NamePlanError extends Error {
  constructor(code, message, path = '$', details = {}) { super(message); this.name = 'NamePlanError'; this.code = code; this.path = path; this.details = details; }
}
export function fail(code, message, path, details) { throw new NamePlanError(code, message, path, details); }
// Bounded validation of exactly the JSON-Schema subset above; no eval or coercion.
export function validateSchema(value, schema, path = '$', root = schema, depth = 0) {
  if (depth > 40) fail('depth', 'ネームの入れ子が深すぎます', path);
  if (schema.$ref) return validateSchema(value, root.$defs.tree, path, root, depth + 1);
  if (schema.anyOf) {
    for (const choice of schema.anyOf) { try { validateSchema(value, choice, path, root, depth + 1); return value; } catch (error) { if (!(error instanceof NamePlanError)) throw error; } }
    fail('schema', 'ネームの値の種類が不正です', path);
  }
  if ('const' in schema && value !== schema.const) fail('schema', '対応しないネーム形式です', path);
  if (schema.enum && !schema.enum.includes(value)) fail('schema', '未対応のネーム指定です', path);
  switch (schema.type) {
    case 'null': if (value !== null) fail('schema', 'nullを指定してください', path); break;
    case 'string':
      if (typeof value !== 'string' || !value.isWellFormed() || (schema.minLength && value.trim().length < schema.minLength) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail('schema', '文字列・IDが不正です', path);
      break;
    case 'number':
      if (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)) fail('schema', '有限の有効な数値を指定してください', path);
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('schema', '配列の件数が不正です', path);
      value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, root, depth + 1));
      break;
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('schema', 'オブジェクトが不正です', path);
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) fail('unknown_field', `未対応の項目です: ${key}`, `${path}.${key}`);
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail('schema', `必要な項目がありません: ${key}`, path);
      for (const [key, item] of Object.entries(value)) validateSchema(item, schema.properties[key], `${path}.${key}`, root, depth + 1);
      break;
  }
  return value;
}
export function parseNameFile(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BYTES) fail('size', 'ネームJSONは4MiB以内です');
  let file; try { file = JSON.parse(raw); } catch { fail('json', 'ネームJSONを読み取れません'); }
  validateSchema(file, fileSchema); return file;
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function treeLeaves(node) { return node.type === 'leaf' ? [node.panelId] : node.children.flatMap(treeLeaves); }
export function unique(values, path) { if (new Set(values).size !== values.length) fail('duplicate', '識別子が重複しています', path); }
export function validatePlan(plan, atoms, characterIds, contextAtoms = atoms) {
  validateSchema(plan, planSchema);
  const atomMap = new Map([...contextAtoms, ...atoms].map(atom => [atom.id, atom])), allowed = new Set(characterIds);
  const coverageIds = plan.coverage.map(entry => entry.atomId);
  if (canonical(coverageIds) !== canonical(atoms.map(atom => atom.id))) fail('coverage', '選択原稿の欠落・重複・順序変更があります', '$.coverage');
  const coverage = new Map(plan.coverage.map(entry => [entry.atomId, entry]));
  for (const entry of plan.coverage) {
    const atom = atomMap.get(entry.atomId);
    if (atom.kind === 'reference' && entry.presentation !== 'reference') fail('markup', '書式・画像リンクは漫画の台詞にできません');
    if (atom.kind !== 'reference' && entry.presentation === 'reference') fail('coverage', '本文を非本文として除外できません');
    if (atom.kind === 'dialogue' && !['dialogue', 'thought', 'narration'].includes(entry.presentation)) fail('dialogue', '引用・台詞は原文のまま掲載してください');
    if (entry.speakerId && !allowed.has(entry.speakerId)) fail('character', '未登録の話者です');
  }
  unique(plan.panels.map(panel => panel.id), '$.panels'); unique(plan.pages.map(page => page.id), '$.pages'); unique(plan.beats.map(beat => beat.id), '$.beats');
  const beatIds = new Set(plan.beats.map(beat => beat.id));
  const primary = plan.panels.flatMap(panel => panel.atomIds);
  if (canonical(primary) !== canonical(coverageIds)) fail('coverage', 'コマの一次原稿対応に欠落・重複・順序変更があります');
  const rank = new Map(contextAtoms.map((atom, i) => [atom.id, i]));
  for (const beat of plan.beats) {
    if (!beat.atomIds.length || beat.atomIds.some(id => !atomMap.has(id))) fail('beat', 'beatの原稿参照が不正です');
    unique(beat.atomIds, '$.beats.atomIds');
    if (beat.atomIds.some((id, i) => i && rank.get(id) <= rank.get(beat.atomIds[i - 1]))) fail('beat', 'beatの原稿順が不正です');
  }
  const priorPanels = new Map();
  for (const panel of plan.panels) {
    for (const key of ['atomIds', 'contextAtomIds', 'beatIds', 'characterIds']) unique(panel[key], `$.panels.${panel.id}.${key}`);
    if (panel.contextAtomIds.some(id => !atomMap.has(id)) || panel.beatIds.some(id => !beatIds.has(id)) || !panel.beatIds.length || panel.characterIds.some(id => !allowed.has(id))) fail('reference', 'コマの原稿・人物・beat参照が不正です');
    if (!panel.atomIds.length && (!panel.contextAtomIds.length || !panel.silentReason.trim())) fail('silent', '無言の追加コマには文脈と挿入理由が必要です');
    const sceneId = atomMap.get(panel.atomIds[0] ?? panel.contextAtomIds[0])?.source?.sceneId;
    const continuity = panel.continuity;
    if (continuity) {
      const characterIds = new Set(panel.characterIds);
      if (continuity.characters?.some(character => !characterIds.has(character.id)) || new Set((continuity.characters ?? []).map(character => character.id)).size !== (continuity.characters ?? []).length) fail('continuity_character', '状態の人物はそのコマの登場人物に限ります', panel.id);
      if (continuity.previousPanelId && priorPanels.get(continuity.previousPanelId) !== sceneId) fail('continuity_previous', '前コマは同じ場面の既出コマを指定してください', panel.id);
    }
    priorPanels.set(panel.id, sceneId);
  }
  let allLeaves = [];
  for (const page of plan.pages) {
    if (!beatIds.has(page.entryBeatId) || page.exit.payoffBeatIds.some(id => !beatIds.has(id))) fail('beat', 'ページのbeat参照が不正です');
    let nodes = 0;
    const visit = (node, depth) => {
      if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('tree_limit', 'ページ構造が複雑すぎます', page.id);
      if (node.type !== 'leaf') {
        if (node.children.length !== node.weights.length) fail('weights', '段組みの子と比率の件数が一致しません', page.id);
        if (node.slant && (node.children.length !== 2 || node.children.some(child => child.type !== 'leaf'))) fail('unsupported_slant', '斜め境界は隣接する2コマに指定してください', page.id);
        node.children.forEach(child => visit(child, depth + 1));
      }
    };
    visit(page.tree, 0);
    const leaves = treeLeaves(page.tree);
    if (!leaves.length || leaves.length > LIMITS.pagePanels) fail('page_size', '1ページは1〜16コマです', page.id);
    allLeaves = allLeaves.concat(leaves);
    for (const id of leaves) if (plan.panels.find(panel => panel.id === id)?.role === 'splash' && leaves.length !== 1) fail('splash', '全面大ゴマは1ページ1コマです', page.id);
  }
  if (canonical(allLeaves) !== canonical(plan.panels.map(panel => panel.id))) fail('order', 'ページのコマ対応・読書順が一致しません');
  return { coverage, atomMap };
}
