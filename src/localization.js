import { sourceUnits } from './core.js';
import { askLLM } from './llm.js';

export const SOURCE_LANGUAGE = 'ja';
export const ENGLISH_LANGUAGE = 'en';

export function allSourceUnits(snapshot) {
  if (!snapshot?.id || !Array.isArray(snapshot.scenes)) throw Error('原作スナップショットがありません');
  return snapshot.scenes.flatMap(scene => sourceUnits(scene.id, scene.text));
}

export function validateEnglishUnits(value, expected) {
  if (!value || !Array.isArray(value.units)) throw Error('英訳の形式が不正です');
  if (value.units.length !== expected.length) throw Error('英訳に原文の欠落または追加があります');
  const translated = new Map();
  value.units.forEach((unit, index) => {
    const source = expected[index];
    if (!unit || unit.id !== source.id || typeof unit.text !== 'string' || !unit.text.trim() || translated.has(unit.id)) {
      throw Error('英訳の段落ID・順序・本文が不正です');
    }
    translated.set(unit.id, unit.text);
  });
  return expected.map(unit => ({ id: unit.id, text: translated.get(unit.id) }));
}

export async function createEnglishLocalization(snapshot, connection) {
  const translated = [];
  for (const scene of snapshot.scenes) {
    const units = sourceUnits(scene.id, scene.text);
    if (!units.length) continue;
    const schema = {
      type: 'object',
      properties: {
        units: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' } },
            required: ['id', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['units'],
      additionalProperties: false,
    };
    const response = JSON.parse(await askLLM(connection, {
      purpose: 'translation',
      schema,
      prompt: JSON.stringify({
        task: 'Translate the Japanese source units into natural English for both manga lettering and video subtitles. Preserve meaning, speaker intent, names, paragraph boundaries, unit IDs, and order. Do not add, remove, merge, split, summarize, explain, or censor content. Return every unit exactly once.',
        units,
      }),
    }));
    translated.push(...validateEnglishUnits(response, units));
  }
  return {
    id: `${snapshot.id}:en`,
    snapshot_id: snapshot.id,
    locale: ENGLISH_LANGUAGE,
    units: translated,
    model: { provider: connection.provider, model: connection.model },
    created_at: new Date().toISOString(),
  };
}

export function currentEnglishLocalization(project, snapshot) {
  return project.localizations?.find(item => item.locale === ENGLISH_LANGUAGE && item.snapshot_id === snapshot?.id) ?? null;
}

export function textForUnits(unitIds, snapshot, localization = null) {
  const source = new Map(allSourceUnits(snapshot).map(unit => [unit.id, unit.text]));
  const translated = localization ? new Map(localization.units.map(unit => [unit.id, unit.text])) : null;
  return unitIds.map(id => {
    if (!source.has(id)) throw Error('原文の参照がありません');
    if (!translated) return source.get(id);
    if (localization.snapshot_id !== snapshot.id || localization.locale !== ENGLISH_LANGUAGE || !translated.has(id)) {
      throw Error('現在の原作に対応する英訳がありません');
    }
    return translated.get(id);
  }).join('\n\n');
}

export function textForPanel(panel, snapshot, localization = null) {
  return textForUnits(panel.unitIds, snapshot, localization);
}

function vttTime(milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds < 0) throw Error('字幕時刻が不正です');
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds % 3600000 / 60000);
  const seconds = Math.floor(milliseconds % 60000 / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function videoWebVTT(shots, snapshots, localization = null) {
  if (!Array.isArray(shots) || !shots.length) throw Error('字幕を書き出す動画ショットがありません');
  const cues = shots.map((shot, index) => {
    if (!Number.isInteger(shot.start_ms) || !Number.isInteger(shot.end_ms) || shot.end_ms <= shot.start_ms) throw Error('字幕時刻が不正です');
    const snapshot = snapshots.find(item => item.id === shot.snapshotId);
    if (!snapshot) throw Error('原作スナップショットがありません');
    const text = textForUnits(shot.unitIds, snapshot, localization).replace(/\r/g, '').replace(/-->/g, '→').trim();
    return `${index + 1}\n${vttTime(shot.start_ms)} --> ${vttTime(shot.end_ms)}\n${text}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
