export class LibraryValidationError extends Error {
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
      'story-library の検査に失敗しました',
      ...unique.map(issue => `${issue.path}: ${issue.message} (${issue.code})`),
    ].join('\n'));
    this.name = 'LibraryValidationError';
    this.code = 'STORY_LIBRARY_INVALID';
    this.issues = unique;
  }
}

export function issue(issues, path, code, message) {
  issues.push({ path, code, message });
}

export function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function checkObject(value, path, required, optional, issues) {
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
