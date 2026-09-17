import { imageHash } from './revisions';
import { completeImage } from './image-recovery';
import { generationSize, imageRequest } from './image-input';
import { call } from './bridge';
import { askLLM } from './llm';
import { orderedScenes, safePath, sourceUnits, validatePlan } from './core';
import { referenceDeclarations, sourceContract, validateSourceContract } from './source-contract';
export async function syncSource(repo, token, episodeId, previous) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('owner/repository の形式で指定してください');
  const commit = await call('github_get', { repo, path: 'commits/main', token });
  const sha = JSON.parse(commit).sha;
  const registered = sourceContract(repo);
  if (previous?.sha === sha && previous.episodeId === episodeId && previous.repo === repo && Array.isArray(previous.references)
    && previous.contract?.aligned_source_commit === registered?.aligned_source_commit) return previous;
  const read = path => call('github_file', { repo, path: safePath(path), sha, token });
  const manifest = JSON.parse(await read('manifest.json'));
  const contract = validateSourceContract(repo, manifest);
  const selected = orderedScenes(manifest, episodeId);
  const scenes = [];
  for (const s of selected) scenes.push({ ...s, text: await read(s.path), design: s.design_path ? await read(s.design_path) : '' });
  const settings = [];
  for (const s of manifest.settings ?? []) settings.push({ ...s, text: await read(s.path) });
  const references = [];
  for (const setting of settings) {
    for (const declaration of referenceDeclarations(setting, contract)) {
      const asset = await call('github_asset', { repo, path: declaration.path, sha, token });
      references.push({ ...declaration, ...asset });
    }
  }
  return {
    id: `${repo}@${sha}:${episodeId}`, repo, sha, episodeId, manifest, scenes, settings, references,
    contract: {
      version: contract.contract_version,
      manifest_schema_version: manifest.schema_version,
      aligned_source_commit: contract.aligned_source_commit,
      aligned_manifest_blob: contract.aligned_manifest_blob,
    },
    at: new Date().toISOString(),
  };
}
export async function planScene(scene, snapshot, characters, model) {
  const units = sourceUnits(scene.id, scene.text);
  if (!units.length) return [];
  const schema = { type: 'object', properties: { panels: { type: 'array', items: { type: 'object', properties: { unitIds: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' }, characterIds: { type: 'array', items: { type: 'string' } } }, required: ['unitIds', 'prompt', 'characterIds'], additionalProperties: false } } }, required: ['panels'], additionalProperties: false };
  const result = await askLLM(model, { schema, prompt: JSON.stringify({ task: '完成脚本の漫画演出を設計。原文を創作・省略・並べ替えない。全unitIdsを順に一度ずつ割り当て、関連する段落をまとめて1コマにする。原作の明示指示を優先。絵のpromptは英語、文字や吹き出しは描かない。人物は登録IDだけ使用。未登録の人物を登録人物で代用しない。ページ配置は別工程で決めるため、ページ当たりのコマ数を制限しない。各コマに出演する人物IDを漏らさず含める。', units, design: scene.design, settings: snapshot.settings, characters: characters.map(({ id, name, description }) => ({ id, name, description })) }) });
  return validatePlan(JSON.parse(result), units, characters).map((p, i) => ({ ...p, id: `${scene.id}:p${i}`, sceneId: scene.id, snapshotId: snapshot.id, status: 'planned', image: null, instructions: [], attempts: 0 }));
}
export async function generatePanel(panel, characters, original = null, instruction = '', job = null, capture = null, styles = [], edit = null) {
  const refs = panel.characterIds.map(id => {
    const c = characters.find(c => c.id === id);
    if (!c?.image || !c?.hash) throw Error(`人物 ${c?.name ?? id} の正本画像がありません`);
    return { id, name: c.name, hash: c.hash, image: c.image };
  });
  for (const style of styles) {
    if (!style.image || !style.hash) throw Error('画風参照が不正です');
    refs.push({ id: style.id, name: `Style: ${style.name}`, hash: style.hash, image: style.image });
  }
  let source = original, mapping = null;
  if (!source && panel.shot_binding && !capture) throw Error('Blenderショットの撮影原本が必要です');
  if (!source && capture) {
    if (capture.id !== panel.capture_revision || capture.panel_id !== panel.id || capture.session_id !== panel.shot_binding?.session_id) throw Error('撮影版とコマの対応が一致しません');
    const response = await call('blender_capture', { sessionId: capture.session_id, requestId: capture.request_id });
    if (response.state.image.hash !== capture.image.hash || response.state.checkpoint.hash !== capture.checkpoint.hash || await imageHash(response.preview) !== capture.image.hash) throw Error('撮影画像の版が一致しません');
    source = response.preview;
    if (panel.image) refs.push({ id: panel.artwork_revision ?? panel.id, name: 'Previous accepted expression / style', image: panel.image, hash: await imageHash(panel.image) });
    instruction = [...(panel.instructions ?? []), instruction].filter(Boolean).join('\n');
  }
  const [width, height] = job?.finishing ? [job.finishing.width,job.finishing.height] : generationSize(original ? [panel.generation?.width ?? 768, panel.generation?.height ?? 768] : capture?.settings?.resolution);
  if(job?.finishing && (!original || job.finishing.parent_hash !== await imageHash(original))) throw Error('仕上げの元画像が変わりました');
  if (source) {
    const { fitInput } = await import('./render');
    const fitted = await fitInput(source, width, height); source = fitted.image; mapping = fitted.mapping;
  }
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const request = imageRequest({ panel, references: refs, original: source, originalHash: source ? await imageHash(source) : null, width, height, seed, instruction, job, capture });
  request.recovery = { version: 1, kind: job?.kind,
    panel: { ...panel, image: null, ...(job?.finishing ? {finishing:job.finishing} : {}), generation: { model: 'flux_2_klein_4b_q8p.ckpt', seed, steps: 4, width, height, input_mapping: mapping, original_hash: request.original_hash, capture_revision: capture?.id ?? panel.capture_revision ?? null, at: new Date().toISOString() }, references: refs.map(({ image, ...r }) => r), status: 'review', attempts: panel.attempts + 1,
      instructions: edit ? [...panel.instructions, instruction] : panel.instructions },
    ...(edit ? { original, original_hash: await imageHash(original), rect: edit.rect } : {}) };
  const image = await call('generate_image', { request });
  return completeImage(request.recovery, image);
}
export async function editRegion(panel, characters, instruction, rect, job = null, styles = []) {
  if (!panel.image) throw Error('先にコマを作画してください');
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some(n => !Number.isFinite(n) || n < 0 || n > 1) || rect[2] <= 0 || rect[3] <= 0 || rect[0] + rect[2] > 1 || rect[1] + rect[3] > 1) throw Error('修正範囲を選択してください');
  return generatePanel(panel, characters, panel.image, instruction, job, null, styles, { rect });
}
