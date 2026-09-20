export const LIBRARY_FORMAT = 'story-library/v1';
export const SOURCE_MAP_FORMAT = 'story-library-source-map/v1';
export const NOVEL_SOURCE_FORMAT = 'novel-source/v1';
export const INVESTOR_LIFE_SOURCE_FORMAT = 'investor-life-source/v1';
export const STORY_SOURCE_FORMAT = 'story-source/v1';

export const WORK_ID = /^[a-z][a-z0-9-]{0,62}$/;
export const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const GIT_SHA = /^[a-f0-9]{40}$/;
export const RELATIVE_ROOT = /^works\/[a-z][a-z0-9-]{0,62}$/;

export const MANUSCRIPT_FORMATS = Object.freeze([
  STORY_SOURCE_FORMAT,
  NOVEL_SOURCE_FORMAT,
  INVESTOR_LIFE_SOURCE_FORMAT,
  'schema-1',
  'schema-4',
]);

export const READ_ADAPTERS = Object.freeze([...MANUSCRIPT_FORMATS]);

export const WORK_FORMATS = Object.freeze(['novel', 'manga']);

export const IMPORT_STATUSES = Object.freeze([
  'pending-access',
  'pending-identification',
  'pending-import',
  'imported',
  'verified',
]);

export const AUTHORITIES = Object.freeze(['origin', 'library']);

export const VISIBILITIES = Object.freeze(['private', 'scheduled', 'public', 'stopped']);
