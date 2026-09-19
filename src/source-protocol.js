import { safePath } from './core.js';
import { FORMAT as STORY_SOURCE_FORMAT } from '../contracts/story-source/paths.mjs';
import { manifestToSourceModel } from '../contracts/story-source/validate.mjs';

const text = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw Error(`${label}が不正です`); return value; };
const records = (items, label) => {
  if (!Array.isArray(items)) throw Error(`${label}は配列が必要です`);
  const ids = new Set();
  return items.map(item => { if (!item || typeof item !== 'object') throw Error(`${label}が不正です`); text(item.id, label); if(ids.has(item.id)) throw Error(`${label}のIDが重複しています`); ids.add(item.id); return {...item}; });
};
const imagePath = path => { safePath(path); if (!/\.(?:png|jpe?g|webp)$/i.test(path)) throw Error('未対応の参照画像です'); return path; };

// Repository identity is runtime data, never a protocol selector.
export function normalizeSourceManifest(manifest) {
  if (manifest?.format === STORY_SOURCE_FORMAT) return normalizeStorySourceManifest(manifest);
  if (manifest?.format === INVESTOR_LIFE_SOURCE_FORMAT) return normalizeInvestorLifeManifest(manifest);
  if (manifest?.format !== undefined) throw Error(`原稿形式 ${manifest.format || '不明'} は未対応です`);
  if (!manifest || ![1,4].includes(manifest.schema_version)) throw Error(`原稿schema ${manifest?.schema_version ?? '不明'} は未対応です`);
  const scenes = records(manifest.scenes, '場面').map(scene => {
    safePath(scene.path); if(scene.design_path) safePath(scene.design_path);
    if(scene.tags !== undefined && (!Array.isArray(scene.tags) || scene.tags.length > 64 || scene.tags.some(tag=>typeof tag !== 'string' || !tag.trim() || [...tag].length > 80))) throw Error('場面タグは空でない文字列の配列が必要です');
    return {...scene, ...(scene.tags ? {tags:[...scene.tags]} : {})};
  });
  const sceneIds = new Set(scenes.map(scene=>scene.id));
  const episodes = records(manifest.episodes, '話').map(episode => {
    if(!Array.isArray(episode.scene_ids) || new Set(episode.scene_ids).size !== episode.scene_ids.length || episode.scene_ids.some(id=>!sceneIds.has(id))) throw Error('話の場面順が不正です');
    return {...episode,scene_ids:[...episode.scene_ids]};
  });
  const settings = records(manifest.settings ?? [], '設定').map(setting=>({...setting,path:safePath(setting.path)}));
  let references = null;
  if(manifest.references !== undefined) {
    if(!manifest.references || !Array.isArray(manifest.references.characters)) throw Error('references.charactersは配列が必要です');
    const names=new Set(),paths=new Set();
    references=manifest.references.characters.map(ref=>{
      const name=text(ref?.name,'参照人物名'),path=imagePath(ref.image);
      if(names.has(name)||paths.has(path)) throw Error('参照画像の人物名またはパスが重複しています');
      names.add(name);paths.add(path);return {name,path,alt:ref.description === undefined ? name : text(ref.description,'参照画像の説明')};
    });
  }
  return {version:1,schema_version:manifest.schema_version,episodes,scenes,settings,references};
}

/**
 * Convert the canonical nested story-source/v1 manifest to the SourceModel
 * shape consumed by the existing sync and production code. The raw manifest
 * remains in the snapshot; this adapter only creates a read-side projection.
 */

function normalizeInvestorLifeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.work || !Array.isArray(manifest.chapters)) {
    throw Error('investor-life-source/v1のmanifestが不正です');
  }
  const episodes = [], scenes = [], used = new Set();
  for (const chapter of manifest.chapters) {
    if (!chapter || typeof chapter !== 'object' || typeof chapter.id !== 'string' || typeof chapter.title !== 'string' || !Array.isArray(chapter.episodes)) {
      throw Error('investor-life-source/v1の章が不正です');
    }
    for (const episode of chapter.episodes) {
      if (!episode || typeof episode !== 'object' || typeof episode.id !== 'string' || typeof episode.title !== 'string' || typeof episode.path !== 'string') {
        throw Error('investor-life-source/v1の話が不正です');
      }
      if (used.has(episode.id)) throw Error('investor-life-source/v1の話IDが重複しています');
      safePath(episode.path);
      used.add(episode.id);
      episodes.push({id: episode.id, title: episode.title, scene_ids: [episode.id], chapterId: chapter.id, chapterTitle: chapter.title});
      scenes.push({id: episode.id, path: episode.path, episodeId: episode.id, episodeTitle: episode.title, chapterId: chapter.id, chapterTitle: chapter.title});
    }
  }
  const settings = records(manifest.settings ?? [], '設定').map(setting => ({id: setting.id, path: safePath(setting.path)}));
  return {
    version: 1,
    format: INVESTOR_LIFE_SOURCE_FORMAT,
    schema_version: INVESTOR_LIFE_SOURCE_FORMAT,
    work: {...manifest.work},
    episodes,
    scenes,
    settings,
    characters: [],
    references: [],
  };
}

function normalizeStorySourceManifest(manifest) {
  const model = manifestToSourceModel(manifest);
  const episodes = model.episodes.map(episode => ({
    id: episode.id,
    title: episode.title,
    scene_ids: episode.scenes.map(scene => scene.id),
  }));
  const scenes = model.scenes.map(scene => ({
    id: scene.id,
    path: scene.path,
    ...(scene.tags === undefined ? {} : {tags:[...scene.tags]}),
    episodeId: scene.episodeId,
    episodeTitle: scene.episodeTitle,
  }));
  const settings = model.settings.map(setting => ({id: setting.id, path: setting.path}));
  const characters = model.characters.map(character => ({
    id: character.id,
    name: character.name,
    ...(character.image === undefined ? {} : {image: character.image}),
    ...(character.description === undefined ? {} : {description: character.description}),
  }));
  const references = characters.filter(character => character.image).map(character => ({
    id: character.id,
    characterId: character.id,
    name: character.name,
    path: character.image,
    alt: character.description || character.name,
    ...(character.description ? {description: character.description} : {}),
  }));
  return {
    version: 1,
    format: STORY_SOURCE_FORMAT,
    schema_version: STORY_SOURCE_FORMAT,
    work: {...model.work},
    episodes,
    scenes,
    settings,
    characters,
    references,
  };
}

export function resolveRepositoryPath(basePath, relativePath) {
  if(typeof relativePath !== 'string' || /[?#%\\:]/.test(relativePath) || relativePath.startsWith('/')) throw Error('安全でない参照画像パス');
  const parts=basePath.split('/').slice(0,-1);
  for(const part of relativePath.split('/')) { if(!part||part==='.') continue; if(part==='..'){if(!parts.length) throw Error('参照画像パスがリポジトリ外を指しています');parts.pop();} else parts.push(part); }
  return safePath(parts.join('/'));
}

// Schema 4 compatibility only: old character captions in any setting, no setting ID/root requirement.
export function referenceDeclarations(model, settings) {
  if(model.references !== null) return model.references;
  if(model.schema_version !== 4) return [];
  const references=[],names=new Set(),paths=new Set();
  for(const setting of settings) for(const match of setting.text.matchAll(/!\[([^\]]+)\]\(([^\s)]+)(?:\s+['"][^'"]*['"])?\)/g)) {
    const alt=match[1].trim(),name=alt.replace(/(?:の)?キャラクター基準画$/, '').trim();
    if(!name||name===alt) continue;
    const path=imagePath(resolveRepositoryPath(setting.path,match[2]));
    if(paths.has(path)) continue;
    if(names.has(name)) throw Error('参照画像の人物名が重複しています');
    names.add(name);paths.add(path);references.push({name,path,alt});
  }
  return references;
}

export function mergeSourceReferences(characters, references, repo, snapshotId) {
  const next = characters.map(character => ({ ...character }));
  for (const reference of references) {
    const characterId = reference.characterId ?? reference.id ?? null;
    const sourceId = `${repo}:${characterId ?? reference.path}`;
    let index = next.findIndex(character => character.source?.id === sourceId);
    if (index < 0) index = next.findIndex(character => character.source?.repo === repo && character.source?.path === reference.path);
    if (index < 0) {
      const candidates = next.filter(character => character.name === reference.name && !character.source);
      if (candidates.length > 1) throw Error(`人物「${reference.name}」の正本候補が複数あるため自動対応付けできません`);
      if (candidates.length === 1) index = next.indexOf(candidates[0]);
    }
    const previous = index >= 0 ? next[index] : null;
    const description = reference.description || reference.alt || reference.name;
    const character = {
      ...(previous ?? {}),
      id: previous?.id ?? `source:${sourceId}`,
      name: reference.name,
      description: previous?.source ? (description || previous.description) : (previous?.description || `原作リポジトリの${description}`),
      image: reference.image,
      hash: reference.hash,
      version: previous ? (previous.hash === reference.hash ? previous.version : (previous.version ?? 1) + 1) : 1,
      source: { id: sourceId, repo, path: reference.path, ...(characterId ? {character_id: characterId} : {}), snapshot_id: snapshotId },
    };
    if (index >= 0) next[index] = character;
    else next.push(character);
  }
  return next;
}

export function protocolLabel(snapshot) {
  const protocol=snapshot?.protocol ?? snapshot?.contract;
  if (!protocol) return '原稿仕様未記録';
  const version = protocol.format ?? protocol.manifest_schema_version;
  return `原稿${version} · 取得版 ${snapshot.sha?.slice(0,8) ?? '未記録'}`;
}
