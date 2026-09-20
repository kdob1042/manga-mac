import { RELATIVE_ROOT } from './ids.mjs';

const UNSAFE = /[\u0000-\u001f?#%:\\]/;

export const WORK_ENTRY = 'work.json';
export const LEGACY_MANIFEST_ENTRY = 'source/manifest.json';
export const MANIFEST_ENTRY_CANDIDATES = Object.freeze([WORK_ENTRY, LEGACY_MANIFEST_ENTRY]);

/**
 * Work-root relative paths are the sandbox for every declared manuscript,
 * setting, and character image. work.json is the single canonical entry.
 * source/manifest.json is a legacy read fallback only; consumers must not
 * resolve manuscript paths from the entry file's directory.
 */
export function safeWorkRelativePath(value, label = 'パス') {
  if (typeof value !== 'string' || !value || value.length > 400) {
    throw new Error(`${label}が不正です`);
  }
  if (value.startsWith('/') || UNSAFE.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label}が作品root内の安全な相対パスではありません`);
  }
  return value;
}

export function assertWorkRoot(root) {
  if (!RELATIVE_ROOT.test(root)) {
    throw new Error('作品rootは works/{workId} 形式です');
  }
  return root;
}

export function joinWorkPath(root, relativePath) {
  const safeRoot = assertWorkRoot(root);
  const safe = safeWorkRelativePath(relativePath, '作品相対パス');
  return `${safeRoot}/${safe}`;
}

export function workEntryPath(root) {
  return joinWorkPath(root, WORK_ENTRY);
}

export function legacyManifestEntryPath(root) {
  return joinWorkPath(root, LEGACY_MANIFEST_ENTRY);
}

/**
 * Compatibility alias for callers that still use the old helper name.
 */
export function manifestEntryPath(root) {
  return workEntryPath(root);
}

export function publicationPath(root) {
  return joinWorkPath(root, 'publication.yaml');
}

export function assertInsideWorkRoot(root, resolvedRelativePath) {
  const safeRoot = assertWorkRoot(root);
  const safe = safeWorkRelativePath(resolvedRelativePath, '解決パス');
  if (safe !== safeRoot && !safe.startsWith(`${safeRoot}/`)) {
    throw new Error('作品rootの外を参照しています');
  }
  return safe;
}
