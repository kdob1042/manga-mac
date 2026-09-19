import { AUTHORITIES, GIT_SHA, REPO, SOURCE_MAP_FORMAT, STABLE_ID, WORK_ID } from './ids.mjs';
import { LibraryValidationError, checkObject, issue, isObject } from './errors.mjs';
import { assertWorkRoot, safeWorkRelativePath } from './paths.mjs';

const ENTRY_REQUIRED = ['workId', 'origin', 'target'];
const ENTRY_OPTIONAL = ['ids', 'files', 'notes', 'status'];
const ORIGIN_REQUIRED = ['repository'];
const ORIGIN_OPTIONAL = ['ref', 'commit', 'path'];
const TARGET_REQUIRED = ['root'];
const TARGET_OPTIONAL = ['path'];
const ID_GROUPS = ['episode', 'scene', 'character', 'setting', 'chapter'];
const FILE_SHA = /^[a-f0-9]{64}$/;

function checkIdMap(map, path, issues) {
  if (map === undefined) return;
  if (!isObject(map)) {
    issue(issues, path, 'OBJECT_REQUIRED', 'ID対応はオブジェクトです');
    return;
  }
  for (const [from, to] of Object.entries(map)) {
    if (!STABLE_ID.test(from) || typeof to !== 'string' || !STABLE_ID.test(to)) {
      issue(issues, `${path}.${from}`, 'INVALID_ID', '固定IDの対応が不正です');
      continue;
    }
    if (from !== to) {
      issue(issues, `${path}.${from}`, 'ID_REWRITTEN', '移行を口実にした固定IDの付け替えは禁止です');
    }
  }
}

function checkFileMap(files, path, issues) {
  if (files === undefined) return;
  if (!Array.isArray(files)) {
    issue(issues, path, 'INVALID_FILES', 'filesは配列です');
    return;
  }
  const usedTargets = new Set();
  files.forEach((file, index) => {
    const filePath = `${path}[${index}]`;
    if (!checkObject(file, filePath, ['origin', 'target', 'sha256'], [], issues)) return;
    for (const [key, value] of [['origin', file.origin], ['target', file.target]]) {
      try {
        safeWorkRelativePath(value, `${filePath}.${key}`);
      } catch (error) {
        issue(issues, `${filePath}.${key}`, 'INVALID_PATH', error.message);
      }
    }
    if (typeof file.sha256 !== 'string' || !FILE_SHA.test(file.sha256)) {
      issue(issues, `${filePath}.sha256`, 'INVALID_HASH', 'ファイルhashはSHA-256の64桁hexです');
    }
    if (usedTargets.has(file.target)) issue(issues, `${filePath}.target`, 'DUPLICATE_PATH', '同じtarget pathが重複しています');
    else usedTargets.add(file.target);
  });
}

export function validateSourceMap(sourceMap, { catalogWorkIds = null } = {}) {
  const issues = [];
  if (!checkObject(sourceMap, '$', ['format', 'authority', 'entries'], ['notes'], issues)) {
    throw new LibraryValidationError(issues);
  }
  if (sourceMap.format !== SOURCE_MAP_FORMAT) {
    issue(issues, '$.format', 'UNSUPPORTED_FORMAT', `形式は${SOURCE_MAP_FORMAT}である必要があります`);
  }
  if (!AUTHORITIES.includes(sourceMap.authority)) {
    issue(issues, '$.authority', 'INVALID_AUTHORITY', 'authorityが不正です');
  }
  if (sourceMap.authority !== 'origin') {
    issue(issues, '$.authority', 'PREMATURE_CUTOVER', '最終増分反映とM7受入までは origin を正本にします');
  }
  if (!Array.isArray(sourceMap.entries)) {
    issue(issues, '$.entries', 'INVALID_ENTRIES', 'entriesは配列です');
    throw new LibraryValidationError(issues);
  }

  const usedWorks = new Set();
  sourceMap.entries.forEach((entry, index) => {
    const path = `$.entries[${index}]`;
    if (!checkObject(entry, path, ENTRY_REQUIRED, ENTRY_OPTIONAL, issues)) return;
    if (!WORK_ID.test(entry.workId)) {
      issue(issues, `${path}.workId`, 'INVALID_ID', 'workIdが不正です');
    } else if (usedWorks.has(entry.workId)) {
      issue(issues, `${path}.workId`, 'DUPLICATE_ID', '同じworkIdの対応が重複しています');
    } else {
      usedWorks.add(entry.workId);
    }
    if (catalogWorkIds && !catalogWorkIds.has(entry.workId)) {
      issue(issues, `${path}.workId`, 'UNKNOWN_WORK', 'catalogにないworkIdです');
    }
    if (checkObject(entry.origin, `${path}.origin`, ORIGIN_REQUIRED, ORIGIN_OPTIONAL, issues)) {
      if (!REPO.test(entry.origin.repository)) {
        issue(issues, `${path}.origin.repository`, 'INVALID_REPOSITORY', 'owner/repository 形式で指定してください');
      }
      if (entry.origin.commit !== undefined && !GIT_SHA.test(entry.origin.commit)) {
        issue(issues, `${path}.origin.commit`, 'INVALID_COMMIT', 'origin commitは40桁SHAです');
      }
      if (entry.origin.path !== undefined) {
        try {
          if (entry.origin.path.startsWith('/') || entry.origin.path.includes('..')) throw new Error('unsafe');
        } catch {
          issue(issues, `${path}.origin.path`, 'INVALID_PATH', 'origin pathが不正です');
        }
      }
    }
    if (checkObject(entry.target, `${path}.target`, TARGET_REQUIRED, TARGET_OPTIONAL, issues)) {
      try {
        assertWorkRoot(entry.target.root);
        if (entry.workId && entry.target.root !== `works/${entry.workId}`) {
          issue(issues, `${path}.target.root`, 'ROOT_MISMATCH', 'target.rootは works/{workId} です');
        }
      } catch (error) {
        issue(issues, `${path}.target.root`, 'INVALID_ROOT', error.message);
      }
      if (entry.target.path !== undefined && entry.target.path !== '.' && entry.target.path !== '') {
        try {
          safeWorkRelativePath(entry.target.path, 'target.path');
        } catch (error) {
          issue(issues, `${path}.target.path`, 'INVALID_PATH', error.message);
        }
      }
    }
    if (entry.ids !== undefined) {
      if (!isObject(entry.ids)) {
        issue(issues, `${path}.ids`, 'OBJECT_REQUIRED', 'idsはオブジェクトです');
      } else {
        for (const key of Object.keys(entry.ids)) {
          if (!ID_GROUPS.includes(key)) issue(issues, `${path}.ids.${key}`, 'UNKNOWN_FIELD', '未知のID分類です');
        }
        for (const group of ID_GROUPS) checkIdMap(entry.ids[group], `${path}.ids.${group}`, issues);
      }
    }
    checkFileMap(entry.files, `${path}.files`, issues);
    if (entry.status !== undefined && !['planned', 'copied', 'verified'].includes(entry.status)) {
      issue(issues, `${path}.status`, 'INVALID_STATUS', 'source-map statusが不正です');
    }
  });

  if (issues.length) throw new LibraryValidationError(issues);
  return sourceMap;
}
