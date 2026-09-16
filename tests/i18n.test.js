import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, messages, normalizeLocale, loadLocale, saveLocale, translate } from '../src/i18n.js';

test('Japanese and English dictionaries have identical keys', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.ja).sort());
});

test('locale normalization and fallback are deterministic', () => {
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('fr-FR'), DEFAULT_LOCALE);
  assert.equal(translate('fr', 'settings'), messages.ja.settings);
  assert.equal(translate('en', 'panelCount', { count: 4 }), '4 panels');
});

test('locale storage persists only supported locale values', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.equal(saveLocale('en-GB', storage), 'en');
  assert.equal(data.get(LOCALE_STORAGE_KEY), 'en');
  assert.equal(loadLocale(storage), 'en');
  data.set(LOCALE_STORAGE_KEY, 'unsupported');
  assert.equal(loadLocale(storage), DEFAULT_LOCALE);
});
