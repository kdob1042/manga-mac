import { imageHash } from './revisions.js';
import { completeImage } from './image-recovery.js';
import { generationSize, imageRequest } from './image-input.js';
import { call } from './bridge.js';
import { executeImage } from './media-runtime.js';
import { askLLM } from './llm.js';
import { orderedScenes, safePath, sourceUnits, validatePlan } from './core.js';
import { referenceDeclarations, normalizeSourceManifest } from './source-protocol.js';
import { defaultImageModelId, imageModel } from './media.js';

const STORY_SOURCE_FORMAT = 'story-source/v1';

async function readManifest(repo, sha, token, invokeCall = call, explicitPath = '') {
  if (explicitPath) {
    const path = safePath(explicitPath);
    return {path, text: await invokeCall('github_file', {repo, path, sha, token})};
  }
  let lastError;
  for (const path of ['manifest.json', 'work.json', 'source/manifest.json']) {
    try {
      return {path, text: await invokeCall('github_file', {repo, path, sha, token})};
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function sourcePath(root, path) {
  const safe = safePath(path);
  return root ? safePath(`${root}/${safe}`) : safe;
}

function assertInside(root, path) {
  if (!root) return;
  const safeRoot = safePath(root);
  if (path !== safeRoot && !path.startsWith(`${safeRoot}/`)) throw Error('作品rootの外側を参照しています');
}

function assertStorySourceHeading(value, path) {
  if (typeof value !== 'string') throw Error(`${path}の本文が文字列ではありません`);
  const firstLine = value.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  if (!/^#[ \t]+\S.*$/.test(firstLine)) throw Error(`${path}の先頭にlevel-one見出しが必要です`);
}

async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}

export async function syncSource(repo, token, episodeId, previous, invokeCall = call, options = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('owner/repository の形式で指定してください');
  const library = options.library ?? null;
  const branch = options.branch ?? library?.branch ?? previous?.sync?.source_branch ?? 'main';
  if (!['dev','main'].includes(branch)) throw Error('原稿ブランチはdevまたはmainを選んでください');
  const pinnedSha = options.commit ?? library?.sha ?? null;
  const sha = pinnedSha ?? JSON.parse(await invokeCall('github_get', {repo, path: `commits/${branch}`, token})).sha;
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw Error('取得commitが不正です');
  const workId = options.workId ?? library?.workId ?? null;
  const entryPath = options.entryPath ?? options.manifestPath ?? library?.entryPath ?? library?.manifestPath ?? '';
  const sourceRootOption = options.sourceRoot ?? library?.sourceRoot ?? '';
  if (workId && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(workId)) throw Error('作品IDが不正です');
  if (options.sceneId && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(options.sceneId)) throw Error('シーンIDが不正です');
  const requestedEpisodeIds = Array.isArray(options.episodeIds) ? [...options.episodeIds] : [episodeId];
  if (!requestedEpisodeIds.length || new Set(requestedEpisodeIds).size !== requestedEpisodeIds.length || requestedEpisodeIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id))) throw Error('取り込む話を選んでください');
  const previousEpisodes = previous?.episodeIds ?? (previous?.episodeId ? [previous.episodeId] : []);
  const sameSource = previous?.repo === repo && (previous?.workId ?? null) === workId;
  let episodeIds = sameSource ? [...new Set([...previousEpisodes,...requestedEpisodeIds])] : requestedEpisodeIds;
  let selectedSceneId = episodeIds.length === 1 ? options.sceneId : null;
  if (previous?.sha === sha && JSON.stringify(previousEpisodes) === JSON.stringify(episodeIds) && previous.repo === repo
    && (previous.workId ?? null) === workId && (!entryPath || previous.sync?.manifest_path === entryPath)
    && (previous.sync?.source_branch ?? 'main') === branch
    && (previous.selectedSceneId ?? null) === (selectedSceneId ?? null)
    && Array.isArray(previous.references) && previous.protocol?.version === 1) return previous;
  const manifestFile = await readManifest(repo, sha, token, invokeCall, entryPath);
  const manifestText = manifestFile.text;
  const manifest = JSON.parse(manifestText);
  const model = normalizeSourceManifest(manifest);
  const sourceRoot = sourceRootOption || options.workRoot || library?.root || '';
  const legacySourceRoot = !sourceRoot && manifestFile.path === 'source/manifest.json' ? 'source' : '';
  assertInside(options.workRoot ?? library?.root ?? '', manifestFile.path);
  if (sourceRoot) assertInside(options.workRoot ?? library?.root ?? '', sourceRoot);
  const read = async path => {
    try {
      return await invokeCall('github_file', {repo, path: sourcePath(sourceRoot, path), sha, token});
    } catch (error) {
      if (!legacySourceRoot) throw error;
      return invokeCall('github_file', {repo, path: sourcePath(legacySourceRoot, path), sha, token});
    }
  };
  if(requestedEpisodeIds.some(id=>!model.episodes.some(e=>e.id===id)))throw Error('選択した話が原稿にありません');
  episodeIds=model.episodes.filter(e=>episodeIds.includes(e.id)).map(e=>e.id);
  selectedSceneId=episodeIds.length===1?options.sceneId:null;
  const ordered = episodeIds.flatMap(id => orderedScenes(model, id));
  if (new Set(ordered.map(scene => scene.id)).size !== ordered.length) throw Error('複数話で場面IDが重複しています');
  const selected = selectedSceneId ? ordered.filter(scene => scene.id === selectedSceneId) : ordered;
  if (selectedSceneId && selected.length !== 1) throw Error('選択したシーンは取込対象の話に存在しません');
  const scenes = [];
  for (const s of selected) {
    const text = await read(s.path);
    if (model.format === 'story-source/v1') assertStorySourceHeading(text, s.path);
    scenes.push({ ...s, text, design: s.design_path ? await read(s.design_path) : '' });
  }
  const settings = [];
  for (const s of model.settings) {
    const text = await read(s.path);
    if (model.format === 'story-source/v1') assertStorySourceHeading(text, s.path);
    settings.push({ ...s, text });
  }
  const references = [];
  for (const declaration of referenceDeclarations(model, settings)) {
    let asset;
    try {
      asset = await invokeCall('github_asset', {repo, path: sourcePath(sourceRoot, declaration.path), sha, token});
    } catch (error) {
      if (!legacySourceRoot) throw error;
      asset = await invokeCall('github_asset', {repo, path: sourcePath(legacySourceRoot, declaration.path), sha, token});
    }
    references.push({ ...declaration, ...asset });
  }
  const scope = episodeIds.join('+');
  const sceneSuffix = selectedSceneId ? `:${selectedSceneId}` : '';
  const snapshot = {
    id: workId ? `${repo}@${sha}:${workId}:${scope}${sceneSuffix}` : `${repo}@${sha}:${scope}${sceneSuffix}`,
    repo, sha, episodeId: episodeIds[0], episodeIds, manifest, scenes, settings, references,
    ...(workId ? {workId} : {}),
    ...(selectedSceneId ? {selectedSceneId} : {}),
    ...(model.characters ? {characters: model.characters} : {}),
    protocol: {version: 1, ...(model.format ? {format: model.format} : {}), manifest_schema_version: manifest.schema_version ?? model.schema_version},
    sync: {source_commit: sha, source_branch:branch, manifest_path: manifestFile.path, ...(sourceRoot ? {source_root: sourceRoot} : {}), manifest_sha256: await sha256(manifestText), at: new Date().toISOString()},
    ...(workId ? {library: {repository: repo, branch, commit: sha, workId, root: options.workRoot ?? library?.root ?? null, manifest_path: manifestFile.path, source_root: sourceRoot, format: model.format ?? options.format ?? null}} : {}),
    at: new Date().toISOString(),
  };
  return snapshot;
}
export async function planScene(scene, snapshot, characters, model, ask = askLLM) {
  const units = sourceUnits(scene.id, scene.text);
  const schema = { type: 'object', properties: { panels: { type: 'array', minItems: 1, items: { type: 'object', properties: { unitIds: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' }, characterIds: { type: 'array', items: { type: 'string' } } }, required: ['unitIds', 'prompt', 'characterIds'], additionalProperties: false } } }, required: ['panels'], additionalProperties: false };
  const task = units.length
    ? '完成脚本の漫画演出を設計。原文を創作・省略・並べ替えない。全unitIdsを順に一度ずつ割り当て、関連する段落をまとめて1コマにする。原作の明示指示を優先。必要に応じて原文に対応しない画像だけのコマを追加してよい。その場合unitIdsは空配列にする。絵のpromptは英語、文字や吹き出しは描かない。人物は登録IDだけ使用。未登録の人物を登録人物で代用しない。ページ配置は別工程で決めるため、ページ当たりのコマ数を制限しない。各コマに出演する人物IDを漏らさず含める。'
    : '原文の段落がない場面です。scene.designと設定から、必ず1つ以上の画像だけのコマを設計する。unitIdsは空配列にする。絵のpromptは英語、文字や吹き出しは描かない。人物は登録IDだけ使用し、未登録の人物を登録人物で代用しない。';
  const result = await ask(model, { schema, prompt: JSON.stringify({ task, units, design: scene.design, settings: snapshot.settings, characters: characters.map(({ id, name, description }) => ({ id, name, description })) }) });
  let plan = JSON.parse(result);
  if (!units.length && (!plan || !Array.isArray(plan.panels) || !plan.panels.length)) {
    plan = { panels: [{ unitIds: [], prompt: typeof scene.design === 'string' && scene.design.trim() ? scene.design.trim() : 'A wordless manga panel with no text or speech balloons.', characterIds: [] }] };
  }
  return validatePlan(plan, units, characters).map((p, i) => ({ ...p, id: `${scene.id}:p${i}`, sceneId: scene.id, snapshotId: snapshot.id, status: 'planned', image: null, instructions: [], attempts: 0 }));
}
export async function generatePanel(panel, characters, original = null, instruction = '', job = null, capture = null, styles = [], edit = null, permit=null, imageModelId = null, inputMode = 'capture') {
  const selected = imageModel(imageModelId ?? job?.media?.registry_id ?? defaultImageModelId);
  if (job?.media && job.media.model_id !== selected.model_id) throw Error('保存済み作画要求の画像モデルを変更できません');
  const refs = panel.characterIds.map(id => {
    const c = characters.find(c => c.id === id);
    if (!c?.image || !c?.hash) throw Error(`人物 ${c?.name ?? id} の正本画像がありません`);
    return { id, name: c.name, hash: c.hash, image: c.image, role:'character' };
  });
  for (const style of styles) {
    if (!style.image || !style.hash) throw Error('画風参照が不正です');
    refs.push({ id: style.id, name: `Style: ${style.name}`, hash: style.hash, image: style.image, role: 'style' });
  }
  let source = original, mapping = null;
  if (inputMode !== 'direct' && !source && panel.shot_binding && !capture) throw Error('Blenderショットの撮影原本が必要です');
  if (!source && capture) {
    if (capture.id !== panel.capture_revision || capture.panel_id !== panel.id || capture.session_id !== panel.shot_binding?.session_id) throw Error('撮影版とコマの対応が一致しません');
    const response = await call('blender_capture', { sessionId: capture.session_id, requestId: capture.request_id });
    if (response.state.image.hash !== capture.image.hash || response.state.checkpoint.hash !== capture.checkpoint.hash || await imageHash(response.preview) !== capture.image.hash) throw Error('撮影画像の版が一致しません');
    source = response.preview;
    if (panel.image) refs.push({ id: panel.artwork_revision ?? panel.id, name: 'Previous accepted expression / style', image: panel.image, hash: await imageHash(panel.image) });
    instruction = [...(panel.instructions ?? []), instruction].filter(Boolean).join('\n');
  }
  const [width, height] = job?.finishing ? [job.finishing.width,job.finishing.height] : generationSize(original ? [panel.generation?.width ?? 768, panel.generation?.height ?? 768] : capture?.settings?.resolution, selected.id);
  if(job?.finishing && (!original || job.finishing.parent_hash !== await imageHash(original))) throw Error('仕上げの元画像が変わりました');
  if (source) {
    const { fitInput } = await import('./canvas-image.js');
    const fitted = await fitInput(source, width, height); source = fitted.image; mapping = fitted.mapping;
  }
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const request = imageRequest({ panel, references: refs, original: source, originalHash: source ? await imageHash(source) : null, width, height, seed, instruction, job, capture, modelId: selected.id });
  request.recovery = { version: 1, kind: job?.kind,
    panel: { ...panel, image: null, ...(job?.finishing ? {finishing:job.finishing} : {}), generation: { registry_id: selected.id, adapter_id: selected.adapter_id, model: selected.model_id, seed, steps: selected.input.steps, width, height, input_mapping: mapping, original_hash: request.original_hash, capture_revision: capture?.id ?? panel.capture_revision ?? null, at: new Date().toISOString() }, references: refs.map(({ image, ...r }) => r), status: 'review', attempts: panel.attempts + 1,
      instructions: edit ? [...panel.instructions, instruction] : panel.instructions },
    ...(edit ? { original, original_hash: await imageHash(original), rect: edit.rect } : {}) };
  const image = await executeImage(selected.id, request, permit);
  return completeImage(request.recovery, image);
}
export async function editRegion(panel, characters, instruction, rect, job = null, styles = [], imageModelId = null) {
  if (!panel.image) throw Error('先にコマを作画してください');
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some(n => !Number.isFinite(n) || n < 0 || n > 1) || rect[2] <= 0 || rect[3] <= 0 || rect[0] + rect[2] > 1 || rect[1] + rect[3] > 1) throw Error('修正範囲を選択してください');
  return generatePanel(panel, characters, panel.image, instruction, job, null, styles, { rect }, null, imageModelId);
}
