import { safePath } from './core.js';

const text = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw Error(`${label}が不正です`); return value; };
const records = (items, label) => {
  if (!Array.isArray(items)) throw Error(`${label}は配列が必要です`);
  const ids = new Set();
  return items.map(item => { if (!item || typeof item !== 'object') throw Error(`${label}が不正です`); text(item.id, label); if(ids.has(item.id)) throw Error(`${label}のIDが重複しています`); ids.add(item.id); return {...item}; });
};
const imagePath = path => { safePath(path); if (!/\.(?:png|jpe?g|webp)$/i.test(path)) throw Error('未対応の参照画像です'); return path; };

// Repository identity is runtime data, never a protocol selector.
export function normalizeSourceManifest(manifest) {
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
    const sourceId = `${repo}:${reference.path}`;
    let index = next.findIndex(character => character.source?.id === sourceId);
    if (index < 0) index = next.findIndex(character => character.name === reference.name && !character.source);
    const previous = index >= 0 ? next[index] : null;
    const character = {
      ...(previous ?? {}),
      id: previous?.id ?? `source:${sourceId}`,
      name: reference.name,
      description: previous?.description || `原作リポジトリの${reference.alt}`,
      image: reference.image,
      hash: reference.hash,
      version: previous ? (previous.hash === reference.hash ? previous.version : (previous.version ?? 1) + 1) : 1,
      source: { id: sourceId, repo, path: reference.path, snapshot_id: snapshotId },
    };
    if (index >= 0) next[index] = character;
    else next.push(character);
  }
  return next;
}

export function protocolLabel(snapshot) {
  const protocol=snapshot?.protocol ?? snapshot?.contract;
  return protocol ? `原稿schema ${protocol.manifest_schema_version} · 取得版 ${snapshot.sha?.slice(0,8) ?? '未記録'}` : '原稿仕様未記録';
}
