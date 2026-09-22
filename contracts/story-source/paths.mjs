/**
 * Path and position helpers for the canonical story-source/v1 contract.
 *
 * Declared manuscript, setting, and asset paths are relative to the work
 * root. The entry file is work.json; its location is not a path base.
 * The helpers deliberately do not touch the filesystem; callers can use the
 * returned paths with GitHub Contents or a local source checkout.
 */

export const FORMAT = 'story-source/v1';
export const MANUSCRIPT_ROOT = 'manuscript';
export const SETTINGS_ROOT = 'settings';
export const ASSETS_ROOT = 'assets';

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/i;
const SCENE_PATH = /^manuscript\/p(\d{2,})\/p(\d{2,})-(\d{2,})\.md$/;

export function safeRelativePath(value, label = 'パス') {
  if (typeof value !== 'string' || !value || value.length > 400) {
    throw new Error(`${label}が不正です`);
  }
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f?#%:]/.test(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`${label}が安全な相対パスではありません`);
  }
  return value;
}

export function sourcePath(value, label = 'パス') {
  return safeRelativePath(value, label);
}

export function resolveSourcePath(sourceRoot, relativePath) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw new Error('sourceルートが不正です');
  const safe = safeRelativePath(relativePath, '作品相対パス');
  // The relative path has already rejected absolute and parent segments. Keep
  // this helper platform-neutral so the same contract can be bundled into the
  // desktop UI and used by a Node-based manuscript builder.
  return `${sourceRoot.replace(/[\\/]+$/, '')}/${safe}`;
}

export function imagePath(value, label = '人物画像パス') {
  const path = safeRelativePath(value, label);
  if (!path.startsWith(`${ASSETS_ROOT}/`) || !IMAGE_EXTENSION.test(path)) {
    throw new Error(`${label}はassets/配下のPNG・JPEG・WebPが必要です`);
  }
  return path;
}

export function settingPath(value, label = '設定パス') {
  const path = safeRelativePath(value, label);
  if (!path.startsWith(`${SETTINGS_ROOT}/`) || !/\.md$/i.test(path)) {
    throw new Error(`${label}はsettings/配下のMarkdownが必要です`);
  }
  return path;
}

export function formatIndex(index, count = index, minimumWidth = 2) {
  if (!Number.isSafeInteger(index) || index < 1 || !Number.isSafeInteger(count) || count < index) {
    throw new Error('連番が不正です');
  }
  const width = Math.max(minimumWidth, String(count).length);
  return String(index).padStart(width, '0');
}

/**
 * Return the canonical path for a 1-based episode/scene position.
 * `episodeCount` and `sceneCount` are used so that a transition to a new
 * digit width can be planned consistently for every existing scene.
 */
export function scenePathFor(
  episodeNumber,
  sceneNumber,
  { episodeCount = episodeNumber, sceneCount = sceneNumber } = {}
) {
  const episode = formatIndex(episodeNumber, episodeCount);
  const scene = formatIndex(sceneNumber, sceneCount);
  return `${MANUSCRIPT_ROOT}/p${episode}/p${episode}-${scene}.md`;
}

export function parseScenePath(value) {
  try {
    safeRelativePath(value, '場面本文パス');
  } catch {
    return null;
  }
  const match = SCENE_PATH.exec(value);
  if (!match || match[1] !== match[2]) return null;
  const episodeNumber = Number(match[1]);
  const sceneNumber = Number(match[3]);
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1 || !Number.isSafeInteger(sceneNumber) || sceneNumber < 1) {
    return null;
  }
  return { episodeNumber, sceneNumber };
}

export function isCanonicalScenePath(value, episodeNumber, sceneNumber, counts = {}) {
  return value === scenePathFor(episodeNumber, sceneNumber, counts);
}

export function declaredPaths(manifest) {
  const paths = [];
  for (const episode of manifest?.episodes ?? []) {
    for (const scene of episode?.scenes ?? []) if (scene?.path) paths.push(scene.path);
  }
  for (const setting of manifest?.settings ?? []) if (setting?.path) paths.push(setting.path);
  for (const character of manifest?.characters ?? []) if (character?.image) paths.push(character.image);
  return paths;
}

export function scenePathMap(manifest) {
  const result = new Map();
  const episodes = manifest?.episodes ?? [];
  for (const [episodeIndex, episode] of episodes.entries()) {
    const scenes = episode?.scenes ?? [];
    for (const [sceneIndex, scene] of scenes.entries()) {
      if (scene?.id) {
        result.set(scene.id, scenePathFor(episodeIndex + 1, sceneIndex + 1, {
          episodeCount: episodes.length,
          sceneCount: scenes.length,
        }));
      }
    }
  }
  return result;
}
