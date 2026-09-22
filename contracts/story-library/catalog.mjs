import {
  AUTHORITIES,
  IMPORT_STATUSES,
  LIBRARY_FORMAT,
  MANUSCRIPT_FORMATS,
  READ_ADAPTERS,
  REPO,
  STABLE_ID,
  WORK_FORMATS,
  WORK_ID,
  GIT_SHA,
} from './ids.mjs';
import { LibraryValidationError, checkObject, issue, isObject } from './errors.mjs';
import { assertWorkRoot } from './paths.mjs';

const WORK_REQUIRED = ['id', 'title', 'root', 'formats', 'manuscriptFormat', 'readAdapters', 'authority', 'origin', 'importStatus'];
const WORK_OPTIONAL = ['notes'];
const ORIGIN_REQUIRED = ['repository'];
const ORIGIN_OPTIONAL = ['ref', 'commit', 'structureCommit', 'manifestPath', 'accessible'];

function checkId(value, path, pattern, issues, used, message) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    issue(issues, path, 'INVALID_ID', message);
    return false;
  }
  if (used.has(value)) {
    issue(issues, path, 'DUPLICATE_ID', 'IDが重複しています');
    return false;
  }
  used.add(value);
  return true;
}

function checkOrigin(origin, path, issues) {
  if (!checkObject(origin, path, ORIGIN_REQUIRED, ORIGIN_OPTIONAL, issues)) return;
  if (typeof origin.repository !== 'string' || !REPO.test(origin.repository)) {
    issue(issues, `${path}.repository`, 'INVALID_REPOSITORY', 'owner/repository 形式で指定してください');
  }
  if (origin.ref !== undefined && (typeof origin.ref !== 'string' || !origin.ref.trim() || origin.ref.length > 200)) {
    issue(issues, `${path}.ref`, 'INVALID_REF', 'Git refが不正です');
  }
  if (origin.commit !== undefined && !GIT_SHA.test(origin.commit)) {
    issue(issues, `${path}.commit`, 'INVALID_COMMIT', '採用元commitは40桁SHAです');
  }
  if (origin.structureCommit !== undefined && !GIT_SHA.test(origin.structureCommit)) {
    issue(issues, `${path}.structureCommit`, 'INVALID_COMMIT', '構造確認用commitは40桁SHAです');
  }
  if (origin.manifestPath !== undefined && (typeof origin.manifestPath !== 'string' || origin.manifestPath.startsWith('/') || origin.manifestPath.includes('..'))) {
    issue(issues, `${path}.manifestPath`, 'INVALID_PATH', 'originのmanifestパスが不正です');
  }
  if (origin.accessible !== undefined && typeof origin.accessible !== 'boolean') {
    issue(issues, `${path}.accessible`, 'INVALID_FLAG', 'accessibleはbooleanです');
  }
}

function normalizeWork(work) {
  return {
    id: work.id,
    title: work.title,
    root: work.root,
    formats: [...work.formats],
    manuscriptFormat: work.manuscriptFormat,
    readAdapters: [...work.readAdapters],
    authority: work.authority,
    origin: {
      repository: work.origin.repository,
      ...(work.origin.ref === undefined ? {} : { ref: work.origin.ref }),
      ...(work.origin.commit === undefined ? {} : { commit: work.origin.commit }),
      ...(work.origin.structureCommit === undefined ? {} : { structureCommit: work.origin.structureCommit }),
      ...(work.origin.manifestPath === undefined ? {} : { manifestPath: work.origin.manifestPath }),
      ...(work.origin.accessible === undefined ? {} : { accessible: work.origin.accessible }),
    },
    importStatus: work.importStatus,
    ...(work.notes === undefined ? {} : { notes: work.notes }),
  };
}

export function validateCatalog(catalog) {
  const issues = [];
  if (!checkObject(catalog, '$', ['format', 'authorityUntil', 'works'], ['notes'], issues)) {
    throw new LibraryValidationError(issues);
  }
  if (catalog.format !== LIBRARY_FORMAT) {
    issue(issues, '$.format', 'UNSUPPORTED_FORMAT', `形式は${LIBRARY_FORMAT}である必要があります`);
  }
  if (catalog.authorityUntil !== 'M8') {
    issue(issues, '$.authorityUntil', 'INVALID_AUTHORITY_WINDOW', '旧原稿repoの正本期間は M8 切替までです');
  }
  if (!Array.isArray(catalog.works)) {
    issue(issues, '$.works', 'INVALID_WORKS', 'worksは配列が必要です');
    throw new LibraryValidationError(issues);
  }
  if (catalog.notes !== undefined && (typeof catalog.notes !== 'string' || catalog.notes.length > 4000)) {
    issue(issues, '$.notes', 'INVALID_TEXT', 'notesが不正です');
  }

  const usedIds = new Set();
  const usedRoots = new Set();
  catalog.works.forEach((work, index) => {
    const path = `$.works[${index}]`;
    if (!checkObject(work, path, WORK_REQUIRED, WORK_OPTIONAL, issues)) return;
    checkId(work.id, `${path}.id`, WORK_ID, issues, usedIds, 'workIdは英小文字・数字・ハイフンです');
    if (typeof work.title !== 'string' || !work.title.trim() || work.title.length > 200) {
      issue(issues, `${path}.title`, 'INVALID_TEXT', '作品タイトルが不正です');
    }
    try {
      assertWorkRoot(work.root);
      if (work.root !== `works/${work.id}`) {
        issue(issues, `${path}.root`, 'ROOT_MISMATCH', '作品rootは works/{workId} と一致させてください');
      }
      if (usedRoots.has(work.root)) issue(issues, `${path}.root`, 'DUPLICATE_ROOT', '作品rootが重複しています');
      else usedRoots.add(work.root);
    } catch (error) {
      issue(issues, `${path}.root`, 'INVALID_ROOT', error.message);
    }
    if (!Array.isArray(work.formats) || work.formats.length === 0 || work.formats.some(item => !WORK_FORMATS.includes(item))) {
      issue(issues, `${path}.formats`, 'INVALID_FORMATS', 'formatsは novel / manga の配列です');
    } else if (new Set(work.formats).size !== work.formats.length) {
      issue(issues, `${path}.formats`, 'DUPLICATE_FORMAT', 'formatsが重複しています');
    }
    if (!MANUSCRIPT_FORMATS.includes(work.manuscriptFormat)) {
      issue(issues, `${path}.manuscriptFormat`, 'UNSUPPORTED_MANUSCRIPT_FORMAT', '未対応の原稿形式です');
    }
    if (!Array.isArray(work.readAdapters) || work.readAdapters.length === 0 || work.readAdapters.some(item => !READ_ADAPTERS.includes(item))) {
      issue(issues, `${path}.readAdapters`, 'INVALID_ADAPTERS', 'readAdaptersが不正です');
    } else if (!work.readAdapters.includes(work.manuscriptFormat)) {
      issue(issues, `${path}.readAdapters`, 'ADAPTER_MISSING_FORMAT', 'manuscriptFormatをreadAdaptersに含めてください');
    }
    if (!AUTHORITIES.includes(work.authority)) {
      issue(issues, `${path}.authority`, 'INVALID_AUTHORITY', 'authorityは origin または library です');
    }
    if (work.importStatus !== 'verified' && work.authority !== 'origin') {
      issue(issues, `${path}.authority`, 'PREMATURE_CUTOVER', 'M7検証と最終増分反映が終わるまで旧原稿repoを正本にしてください');
    }
    if (!IMPORT_STATUSES.includes(work.importStatus)) {
      issue(issues, `${path}.importStatus`, 'INVALID_IMPORT_STATUS', 'importStatusが不正です');
    }
    if (work.notes !== undefined && (typeof work.notes !== 'string' || work.notes.length > 4000)) {
      issue(issues, `${path}.notes`, 'INVALID_TEXT', 'notesが不正です');
    }
    checkOrigin(work.origin, `${path}.origin`, issues);
  });

  if (issues.length) throw new LibraryValidationError(issues);
  return {
    format: LIBRARY_FORMAT,
    authorityUntil: 'M8',
    works: catalog.works.map(normalizeWork),
    ...(catalog.notes === undefined ? {} : { notes: catalog.notes }),
  };
}

export function findWork(catalog, workId) {
  const normalized = isObject(catalog) && catalog.format === LIBRARY_FORMAT && Array.isArray(catalog.works)
    ? catalog
    : validateCatalog(catalog);
  return normalized.works.find(work => work.id === workId) ?? null;
}

export function importedWorks(catalog) {
  return validateCatalog(catalog).works.filter(work => work.importStatus === 'imported' || work.importStatus === 'verified');
}
