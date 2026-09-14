import { call } from './bridge';
import { orderedScenes, safePath, sourceUnits, validatePlan } from './core';
export async function syncSource(repo, token, episodeId, previous) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('owner/repository の形式で指定してください');
  const commit = await call('github_get', { repo, path: 'commits/main', token });
  const sha = JSON.parse(commit).sha;
  if (previous?.sha === sha && previous.episodeId === episodeId && previous.repo === repo) return previous;
  const read = path => call('github_file', { repo, path: safePath(path), sha, token });
  const manifest = JSON.parse(await read('manifest.json'));
  const selected = orderedScenes(manifest, episodeId);
  const scenes = [];
  for (const s of selected) scenes.push({ ...s, text: await read(s.path), design: s.design_path ? await read(s.design_path) : '' });
  const settings = [];
  for (const s of manifest.settings ?? []) settings.push({ ...s, text: await read(s.path) });
  return { id: `${repo}@${sha}:${episodeId}`, repo, sha, episodeId, manifest, scenes, settings, at: new Date().toISOString() };
}
export async function planScene(scene, snapshot, characters, model) {
  const units = sourceUnits(scene.id, scene.text);
  if (!units.length) return [];
  const schema = { type: 'object', properties: { panels: { type: 'array', items: { type: 'object', properties: { unitIds: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' }, characterIds: { type: 'array', items: { type: 'string' } } }, required: ['unitIds', 'prompt', 'characterIds'], additionalProperties: false } } }, required: ['panels'], additionalProperties: false };
  const result = await call('ollama', { model, schema, prompt: JSON.stringify({ task: '完成脚本の漫画演出を設計。原文を創作・省略・並べ替えない。全unitIdsを順に一度ずつ割り当て、関連する段落をまとめて1コマにする。原作の明示指示を優先。絵のpromptは英語、文字や吹き出しは描かない。人物は登録IDだけ使用。未登録の人物を登録人物で代用しない。最大4コマ/ページを想定。各コマに出演する人物IDを漏らさず含める。', units, design: scene.design, settings: snapshot.settings, characters: characters.map(({ id, name, description }) => ({ id, name, description })) }) });
  return validatePlan(JSON.parse(result), units, characters).map((p, i) => ({ ...p, id: `${scene.id}:p${i}`, sceneId: scene.id, snapshotId: snapshot.id, status: 'planned', image: null, instructions: [], attempts: 0 }));
}
export async function generatePanel(panel, characters, original = null, instruction = '') {
  const refs = panel.characterIds.map(id => {
    const c = characters.find(c => c.id === id);
    if (!c?.image || !c?.hash) throw Error(`人物 ${c?.name ?? id} の正本画像がありません`);
    return { id, name: c.name, hash: c.hash, image: c.image };
  });
  const image = await call('generate_image', { request: { prompt: `${panel.prompt}\n${instruction}\nBlack and white manga illustration. No text, no lettering, no balloons. Preserve identities from the numbered reference images: ${refs.map((r, i) => `${i + 1}: ${r.name}`).join(', ')}`, references: refs, original } });
  return { ...panel, image, references: refs.map(({ image, ...r }) => r), status: 'review', attempts: panel.attempts + 1 };
}
export async function editRegion(panel, characters, instruction, rect) {
  if (!panel.image) throw Error('先にコマを作画してください');
  const next = await generatePanel(panel, characters, panel.image, instruction);
  const { mergeRegion } = await import('./render');
  return { ...next, image: await mergeRegion(panel.image, next.image, rect), instructions: [...panel.instructions, instruction] };
}
