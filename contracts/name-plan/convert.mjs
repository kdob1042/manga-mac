import { bindEmbeddedSource } from './source.mjs';
import { parseNameFile, validatePlan } from './schema.mjs';
import { compileNameLayout } from './layout.mjs';
import { PAGE_FORMAT, validateEpisode } from './page.mjs';

const printed = kind => ['dialogue', 'thought', 'narration'].includes(kind);

// One-time compatibility adapter; never regenerate this from a v2 file after a page is edited.
export async function embeddedV2ToEpisode(input) {
  const file = typeof input === 'string' ? parseNameFile(input) : parseNameFile(JSON.stringify(input));
  if (file.source.kind !== 'embedded') throw Error('旧ネームの原文が内包されていません。元の原稿とともに移行してください');
  const bound = await bindEmbeddedSource(file, { workId: file.source.workId });
  const checked = validatePlan(file.plan, bound.atoms, file.source.characters.map(c => c.id), bound.contextAtoms);
  const geometry = compileNameLayout(file.plan).layout;
  const atoms = new Map(bound.contextAtoms.map(atom => [atom.id, atom]));
  const scenes = file.source.scenes.map(scene => ({ id: scene.id, label: scene.id, location: '', timeOfDay: '', props: [], spatial: '', hardConstraints: [], appearances: [] }));
  const appearances = new Map();
  const panels = new Map(file.plan.panels.map(panel => {
    const first = atoms.get(panel.atomIds[0] ?? panel.contextAtomIds[0]);
    const sceneId = first?.source.sceneId ?? null;
    const entry = scenes.find(scene => scene.id === sceneId);
    const characters = panel.characterIds.map(characterId => {
      const continuity = panel.continuity?.characters?.find(c => c.id === characterId);
      const costume = continuity?.costume?.trim() ?? '';
      let appearanceId = null;
      if (entry && costume) {
        const key = JSON.stringify([sceneId, characterId, costume]);
        if (!appearances.has(key)) {
          appearanceId = `appearance:${entry.id}:${characterId}:${entry.appearances.length + 1}`;
          entry.appearances.push({ id: appearanceId, characterId, label: costume, costume, visualState: '' });
          appearances.set(key, appearanceId);
        } else appearanceId = appearances.get(key);
      }
      return { characterId, appearanceId, visualState: continuity?.visualState ?? '', emotion: continuity?.emotion ?? '', holding: continuity?.holding ?? [] };
    });
    const texts = panel.atomIds.flatMap((id, i) => {
      const presentation = checked.coverage.get(id);
      if (!printed(presentation?.presentation)) return [];
      return [{ id: `text:${panel.id}:${i}`, kind: presentation.presentation, speakerId: presentation.speakerId ?? null, text: atoms.get(id).text, box: null }];
    });
    return [panel.id, { id: panel.id, sceneId, sourceExcerptIds: [...panel.atomIds], contextExcerptIds: [...panel.contextAtomIds], beatIds: [...panel.beatIds], characters, prompt: panel.prompt, shotIntent: panel.shotIntent, protect: panel.protect, gaze: panel.gaze, intent: panel.role, previousPanelId: panel.continuity?.previousPanelId ?? null, texts, frame: null }];
  }));
  const pages = file.plan.pages.map(page => {
    const compiled = geometry.pages.find(p => p.id === page.id);
    const order = compiled.slots.map(slot => slot.panelId).filter(Boolean);
    const selected = order.map(id => panels.get(id));
    const primary = [...new Set(selected.flatMap(p => p.sourceExcerptIds))], context = [...new Set(selected.flatMap(p => p.contextExcerptIds))];
    for (const slot of compiled.slots) if (slot.panelId) panels.get(slot.panelId).frame = { points: slot.points, slotId: slot.id, ...(slot.overflow ? { overflow: slot.overflow } : {}) };
    return { id: page.id, purpose: page.purpose, entryBeatId: page.entryBeatId, exit: page.exit, sourceExcerpts: primary.map(id => ({ id, text: atoms.get(id).text, origin: atoms.get(id).source })), contextExcerpts: context.map(id => ({ id, text: atoms.get(id).text, kind: 'source', origin: atoms.get(id).source })), boundaryContext: { before: null, after: null }, panels: selected };
  });
  return validateEpisode({ format: PAGE_FORMAT, workId: file.source.workId, episodeId: file.source.episodeId, title: file.title, readingDirection: 'rtl', characters: file.source.characters.map(c => ({ ...c })), workGoal: file.plan.workGoal, beats: file.plan.beats.map(beat => ({ ...beat })), scenes, boundaryContext: { before: null, after: null }, pageIds: pages.map(p => p.id), pages });
}
