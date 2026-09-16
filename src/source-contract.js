import contractData from '../source-contracts/kamiya-kawai.json' with { type: 'json' };

const contracts = new Map([[contractData.repository.toLowerCase(), contractData]]);

export function sourceContract(repo) {
  return contracts.get(String(repo).toLowerCase()) ?? null;
}

export function validateSourceContract(repo, manifest) {
  const contract = sourceContract(repo);
  if (!contract) throw Error(`原作リポジトリの構成仕様が未登録です: ${repo}`);
  if (!contract.compatible_manifest_schema_versions.includes(manifest.schema_version)) {
    throw Error(`原作の構成仕様 schema ${manifest.schema_version ?? '不明'} は未対応です。アプリの対応版を確認してください`);
  }
  if (!Array.isArray(manifest.settings) || !manifest.settings.some(item => item.id === contract.reference_images.setting_id)) {
    throw Error(`原作の参照画像設定 ${contract.reference_images.setting_id} がありません`);
  }
  return contract;
}

export function resolveRepositoryPath(basePath, relativePath) {
  if (typeof relativePath !== 'string' || /[?#%\\]/.test(relativePath) || relativePath.startsWith('/')) throw Error('安全でない参照画像パス');
  const parts = basePath.split('/').slice(0, -1);
  for (const part of relativePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw Error('参照画像パスがリポジトリ外を指しています');
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) throw Error('参照画像パスが不正です');
  return parts.join('/');
}

export function referenceDeclarations(setting, contract) {
  if (setting.id !== contract.reference_images.setting_id) return [];
  const roots = contract.reference_images.allowed_roots;
  const seen = new Set(), references = [];
  const markdownImage = /!\[([^\]]+)\]\(([^\s)]+)(?:\s+['"][^'"]*['"])?\)/g;
  for (const match of setting.text.matchAll(markdownImage)) {
    const path = resolveRepositoryPath(setting.path, match[2]);
    if (!roots.some(root => path.startsWith(root)) || !/\.(?:png|jpe?g|webp)$/i.test(path)) throw Error(`許可されていない参照画像です: ${path}`);
    if (seen.has(path)) continue;
    seen.add(path);
    const alt = match[1].trim();
    const name = alt.replace(/(?:の)?キャラクター基準画$/, '').trim();
    if (!name || name === alt) throw Error(`参照画像の人物名を判定できません: ${alt}`);
    references.push({ path, name, alt });
  }
  if (!references.length) throw Error('キャラクター基準画が原作のVISUAL設定にありません');
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

export function contractLabel(snapshot) {
  const contract = snapshot?.contract;
  if (!contract) return '構成仕様未記録';
  return `構成schema ${contract.manifest_schema_version}対応 · 確認基準 ${contract.aligned_source_commit.slice(0, 8)}`;
}
