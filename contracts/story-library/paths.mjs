import { RELATIVE_ROOT } from './ids.mjs';

const UNSAFE = /[\u0000-\u001f?#%:\\]/;

/**
 * Work-root relative paths are the sandbox for every declared manuscript,
 * setting, and character image.  `source/manifest.json` is only the entry
 * file; callers must not resolve `manuscript/` from the `source/` directory.
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

export function manifestEntryPath(root) {
  return joinWorkPath(root, 'source/manifest.json');
}

export function publicationPath(root) {
  return joinWorkPath(root, 'publication.yaml');
}

/**
 * Reject any resolved path that leaves the work root.  Manifest paths are
 * already work-root relative; this is the last sandbox check for callers
 * that join filesystem paths themselves.
 */
export function assertInsideWorkRoot(root, resolvedRelativePath) {
  const safeRoot = assertWorkRoot(root);
  const safe = safeWorkRelativePath(resolvedRelativePath, '解決パス');
  if (safe !== safeRoot && !safe.startsWith(`${safeRoot}/`)) {
    throw new Error('作品rootの外を参照しています');
  }
  return safe;
}
