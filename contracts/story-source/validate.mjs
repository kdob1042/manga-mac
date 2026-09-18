import {
  ASSETS_ROOT,
  FORMAT,
  declaredPaths,
  imagePath,
  parseScenePath,
  safeRelativePath,
  scenePathFor,
  settingPath as validateSettingPath,
} from './paths.mjs';

export const LIMITS = Object.freeze({
  id: 128,
  title: 200,
  description: 4000,
  path: 400,
  tags: 64,
  tag: 80,
  files: 10000,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export class StorySourceValidationError extends Error {
  constructor(issues) {
    const unique = [];
    const seen = new Set();
    for (const issue of issues) {
      const key = `${issue.code}:${issue.path}:${issue.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(issue);
      }
    }
    super([
      'story-source/v1 の検査に失敗しました',
      ...unique.map(issue => `${issue.path}: ${issue.message} (${issue.code})`),
    ].join('\n'));
    this.name = 'StorySourceValidationError';
    this.code = 'STORY_SOURCE_INVALID';
    this.issues = unique;
  }
}

function issue(issues, path, code, message) {
  issues.push({ path, code, message });
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function checkObject(value, path, required, optional, issues) {
  if (!isObject(value)) {
    issue(issues, path, 'OBJECT_REQUIRED', 'オブジェクトが必要です');
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(issues, `${path}.${key}`, 'UNKNOWN_FIELD', '未知の項目です');
  }
  for (const key of required) {
    if (!(key in value)) issue(issues, `${path}.${key}`, 'MISSING_FIELD', '必須項目です');
  }
  return true;
}

function checkText(value, path, issues, { max = LIMITS.title, required = true } = {}) {
  if (value === undefined && !required) return false;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max || TEXT_CONTROL.test(value)) {
    issue(issues, path, 'INVALID_TEXT', required ? '空でない文字列が必要です' : '文字列が不正です');
    return false;
  }
  return true;
}

function checkId(value, path, issues, used, retired) {
  if (!checkText(value, path, issues, { max: LIMITS.id })) return false;
  if (!ID.test(value)) {
    issue(issues, path, 'INVALID_ID', 'IDは英数字で始まる英数字・_・:・-の128文字以内で指定してください');
    return false;
  }
  if (retired.has(value)) issue(issues, path, 'RETIRED_ID_REUSED', '削除済みIDを再利用できません');
  if (used.has(value)) issue(issues, path, 'DUPLICATE_ID', 'IDが重複しています');
  else used.add(value);
  return true;
}

function checkSafePath(value, path, issues, checker = safeRelativePath) {
  try {
    checker(value, path);
    return true;
  } catch (error) {
    issue(issues, path, 'INVALID_PATH', error.message);
    return false;
  }
}

function checkTags(value, path, issues) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > LIMITS.tags) {
    issue(issues, path, 'INVALID_TAGS', `タグは${LIMITS.tags}個以内の配列が必要です`);
    return;
  }
  value.forEach((tag, index) => {
    checkText(tag, `${path}[${index}]`, issues, { max: LIMITS.tag });
  });
}

function checkManifestShape(manifest, issues) {
  const top = ['format', 'work', 'episodes', 'settings', 'characters'];
  if (!checkObject(manifest, '$', top, [], issues)) return false;
  if (manifest.format !== FORMAT) issue(issues, '$.format', 'UNSUPPORTED_FORMAT', `形式は${FORMAT}である必要があります`);
  return true;
}

function normalizeManifest(manifest) {
  return {
    format: FORMAT,
    work: { title: manifest.work.title },
    episodes: manifest.episodes.map(episode => ({
      id: episode.id,
      title: episode.title,
      scenes: episode.scenes.map(scene => ({
        id: scene.id,
        path: scene.path,
        ...(scene.tags === undefined ? {} : { tags: [...scene.tags] }),
      })),
    })),
    settings: manifest.settings.map(setting => ({ id: setting.id, path: setting.path })),
    characters: manifest.characters.map(character => ({
      id: character.id,
      name: character.name,
      ...(character.image === undefined ? {} : { image: character.image }),
      ...(character.description === undefined ? {} : { description: character.description }),
    })),
  };
}

/**
 * Validate and normalize a story-source/v1 manifest without reading files.
 * The returned value is a new JSON-shaped object; the caller's manifest is
 * never mutated and its text/tags are not trimmed or otherwise normalized.
 */
export function validateManifest(manifest, { retiredIds = [] } = {}) {
  const issues = [];
  if (!checkManifestShape(manifest, issues)) throw new StorySourceValidationError(issues);

  const retired = new Set(Array.isArray(retiredIds) ? retiredIds : []);
  checkObject(manifest.work, '$.work', ['title'], [], issues);
  checkText(manifest.work?.title, '$.work.title', issues);

  if (!Array.isArray(manifest.episodes) || manifest.episodes.length === 0) {
    issue(issues, '$.episodes', 'INVALID_EPISODES', '1件以上の話を配列で指定してください');
  }
  if (!Array.isArray(manifest.settings)) issue(issues, '$.settings', 'INVALID_SETTINGS', '設定は配列が必要です');
  if (!Array.isArray(manifest.characters)) issue(issues, '$.characters', 'INVALID_CHARACTERS', '人物は配列が必要です');

  const usedIds = new Set();
  const usedPaths = new Map();
  const episodes = Array.isArray(manifest.episodes) ? manifest.episodes : [];

  episodes.forEach((episode, episodeIndex) => {
    const episodePath = `$.episodes[${episodeIndex}]`;
    if (!checkObject(episode, episodePath, ['id', 'title', 'scenes'], [], issues)) return;
    checkId(episode.id, `${episodePath}.id`, issues, usedIds, retired);
    checkText(episode.title, `${episodePath}.title`, issues);
    if (!Array.isArray(episode.scenes)) {
      issue(issues, `${episodePath}.scenes`, 'INVALID_SCENES', '場面は配列が必要です');
      return;
    }
    episode.scenes.forEach((scene, sceneIndex) => {
      const scenePath = `${episodePath}.scenes[${sceneIndex}]`;
      if (!checkObject(scene, scenePath, ['id', 'path'], ['tags'], issues)) return;
      checkId(scene.id, `${scenePath}.id`, issues, usedIds, retired);
      checkTags(scene.tags, `${scenePath}.tags`, issues);
      const pathField = `${scenePath}.path`;
      if (!checkSafePath(scene.path, pathField, issues)) return;
      const parsed = parseScenePath(scene.path);
      const expected = scenePathFor(episodeIndex + 1, sceneIndex + 1, {
        episodeCount: episodes.length,
        sceneCount: episode.scenes.length,
      });
      if (!parsed || scene.path !== expected) {
        issue(issues, pathField, 'NON_CANONICAL_SCENE_PATH', `配列位置に対応する${expected}で指定してください`);
      }
      registerPath(scene.path, pathField, usedPaths, issues);
    });
  });

  const settings = Array.isArray(manifest.settings) ? manifest.settings : [];
  settings.forEach((setting, index) => {
    const settingRecordPath = `$.settings[${index}]`;
    if (!checkObject(setting, settingRecordPath, ['id', 'path'], [], issues)) return;
    checkId(setting.id, `${settingRecordPath}.id`, issues, usedIds, retired);
    const pathField = `${settingRecordPath}.path`;
    if (checkSafePath(setting.path, pathField, issues, validateSettingPath)) {
      if (!setting.path.startsWith('settings/') || !/\.md$/i.test(setting.path)) {
        issue(issues, pathField, 'INVALID_SETTING_PATH', 'settings/配下のMarkdownを指定してください');
      }
      registerPath(setting.path, pathField, usedPaths, issues);
    }
  });

  const characters = Array.isArray(manifest.characters) ? manifest.characters : [];
  characters.forEach((character, index) => {
    const characterPath = `$.characters[${index}]`;
    if (!checkObject(character, characterPath, ['id', 'name'], ['image', 'description'], issues)) return;
    checkId(character.id, `${characterPath}.id`, issues, usedIds, retired);
    checkText(character.name, `${characterPath}.name`, issues);
    if (character.description !== undefined) checkText(character.description, `${characterPath}.description`, issues, { max: LIMITS.description });
    if (character.image !== undefined) {
      const pathField = `${characterPath}.image`;
      if (checkSafePath(character.image, pathField, issues, imagePath)) registerPath(character.image, pathField, usedPaths, issues);
    }
  });

  // Keep this check explicit so callers get a useful diagnostic even when a
  // future manifest field is added without updating normalization.
  for (const path of declaredPaths(manifest)) {
    if (typeof path !== 'string') issue(issues, '$', 'INVALID_PATH', '宣言されたパスが文字列ではありません');
  }

  if (issues.length) throw new StorySourceValidationError(issues);
  return normalizeManifest(manifest);
}

function registerPath(path, fieldPath, usedPaths, issues) {
  if (typeof path !== 'string') return;
  const previous = usedPaths.get(path);
  if (previous) issue(issues, fieldPath, 'DUPLICATE_PATH', `同じファイルを${previous}でも参照しています`);
  else usedPaths.set(path, fieldPath);
}

function fileEntries(files) {
  if (files instanceof Map) return [...files.entries()];
  if (Array.isArray(files)) return files.map(path => [path, undefined]);
  if (isObject(files)) return Object.entries(files);
  throw new Error('filesはMap、パス配列、またはパスから内容へのオブジェクトが必要です');
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: true }).decode(value);
  return null;
}

function hasContent(value) {
  if (typeof value === 'string') return value.length > 0;
  return value instanceof Uint8Array && value.byteLength > 0;
}

function checkHeading(content, path, issues) {
  if (content === null) return;
  let firstLine;
  try {
    firstLine = content.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  } catch {
    issue(issues, path, 'INVALID_TEXT_FILE', 'UTF-8のMarkdown本文を読み取れません');
    return;
  }
  if (!/^#(?!#)[ \t]+\S.*$/.test(firstLine)) {
    issue(issues, path, 'MISSING_HEADING', '先頭行に「# タイトル」形式の見出しが必要です');
  }
}

/**
 * Validate a manifest together with a source-relative file listing or a map
 * of source-relative paths to file contents.  Binary image format/hash checks
 * remain at the Rust storage boundary; this function only verifies declaration
 * coverage and text headings.
 */
export function validateSourceTree(manifest, files, options = {}) {
  const normalized = validateManifest(manifest, options);
  if (files === undefined) return { manifest: normalized, files: null, paths: declaredPaths(normalized) };

  const issues = [];
  let entries;
  try {
    entries = fileEntries(files);
  } catch (error) {
    throw new StorySourceValidationError([{ path: '$.files', code: 'INVALID_FILES', message: error.message }]);
  }
  if (entries.length > LIMITS.files) issue(issues, '$.files', 'TOO_MANY_FILES', `ファイルは${LIMITS.files}件以内にしてください`);

  const actual = new Map();
  for (const [rawPath, content] of entries) {
    let path;
    try {
      path = safeRelativePath(rawPath, 'ファイルパス');
    } catch (error) {
      issue(issues, '$.files', 'INVALID_FILE_PATH', error.message);
      continue;
    }
    if (actual.has(path)) issue(issues, '$.files', 'DUPLICATE_FILE_PATH', `ファイルが重複しています: ${path}`);
    else actual.set(path, content);
  }

  const expected = new Set(declaredPaths(normalized));
  for (const path of expected) {
    if (!actual.has(path)) issue(issues, path, 'MISSING_FILE', 'manifestで宣言されたファイルがありません');
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) issue(issues, path, 'UNREGISTERED_FILE', 'manifestで宣言されていないファイルです');
  }

  const textPaths = new Set([
    ...normalized.episodes.flatMap(episode => episode.scenes.map(scene => scene.path)),
    ...normalized.settings.map(setting => setting.path),
  ]);
  for (const path of textPaths) {
    if (!actual.has(path) || !hasContent(actual.get(path))) continue;
    const content = textContent(actual.get(path));
    checkHeading(content, path, issues);
  }
  for (const character of normalized.characters) {
    const value = actual.get(character.image);
    if (value !== undefined && !hasContent(value)) issue(issues, character.image, 'EMPTY_ASSET', '人物画像ファイルが空です');
  }

  if (issues.length) throw new StorySourceValidationError(issues);
  return { manifest: normalized, files: new Map(actual), paths: [...expected] };
}

export function manifestToSourceModel(manifest, options = {}) {
  const normalized = validateManifest(manifest, options);
  const scenes = [];
  normalized.episodes.forEach((episode, episodeIndex) => {
    episode.scenes.forEach((scene, sceneIndex) => {
      scenes.push({
        ...scene,
        episodeId: episode.id,
        episodeTitle: episode.title,
        episodeNumber: episodeIndex + 1,
        sceneNumber: sceneIndex + 1,
        displayNumber: `P${episodeIndex + 1}-${sceneIndex + 1}`,
      });
    });
  });
  return { ...normalized, scenes };
}

export const validate = validateManifest;
