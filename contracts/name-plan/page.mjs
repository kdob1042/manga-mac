// The portable, editable name. Artwork, jobs, credentials and captures never live here.
export const PAGE_FORMAT = 'manga-mac/name-plan/v3';
export const MAX_PAGE_PANELS = 16;
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const copy = value => structuredClone(value);
const check = (condition, message) => { if (!condition) throw Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ids = (items, label) => {
  check(Array.isArray(items) && items.every(x => object(x) && ID.test(x.id)), `${label}のIDが不正です`);
  check(new Set(items.map(x => x.id)).size === items.length, `${label}のIDが重複しています`);
  return new Set(items.map(x => x.id));
};
const optionalId = value => value == null || ID.test(value);
function frame(value) {
  if (value == null) return;
  check(object(value) && Array.isArray(value.points) && value.points.length === 4 &&
    value.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)), 'コマ枠は0～1の四隅で指定してください');
}
function text(value, label) { check(typeof value === 'string' && value.length <= 20000, `${label}が不正です`); }

export function validateEpisode(episode) {
  check(object(episode) && episode.format === PAGE_FORMAT && ID.test(episode.workId) && ID.test(episode.episodeId), '話の形式・固定IDが不正です');
  check(typeof episode.title === 'string' && episode.readingDirection === 'rtl', '話のタイトル・読み方向が不正です');
  const characters = ids(episode.characters ?? [], '人物');
  const beats = ids(episode.beats ?? [], 'ビート');
  const scenes = ids(episode.scenes ?? [], 'シーン');
  const pages = ids(episode.pages ?? [], 'ページ');
  check(Array.isArray(episode.pageIds) && episode.pageIds.length === pages.size &&
    new Set(episode.pageIds).size === pages.size && episode.pageIds.every(id => pages.has(id)), '話のページ索引が不正です');
  const panelOwners = new Map();
  for (const scene of episode.scenes) {
    ids(scene.appearances ?? [], '衣装');
    for (const appearance of scene.appearances ?? []) check(characters.has(appearance.characterId), `衣装 ${appearance.id} の人物がありません`);
  }
  for (const page of episode.pages) {
    check(Array.isArray(page.sourceExcerpts) && Array.isArray(page.contextExcerpts) && Array.isArray(page.panels) && page.panels.length <= MAX_PAGE_PANELS, `ページ ${page.id} の内容が不正です`);
    const excerpts = ids(page.sourceExcerpts, '原文');
    const contexts = ids(page.contextExcerpts, '参考文');
    for (const source of page.sourceExcerpts) text(source.text, '原文');
    for (const context of page.contextExcerpts) text(context.text, '参考文');
    ids(page.panels, 'コマ');
    for (const panel of page.panels) {
      check(!panelOwners.has(panel.id), `コマ ${panel.id} が別ページにも存在します`);
      panelOwners.set(panel.id, page.id);
      check(optionalId(panel.sceneId) && (panel.sceneId == null || scenes.has(panel.sceneId)), `コマ ${panel.id} のシーンがありません`);
      check((panel.sourceExcerptIds ?? []).every(id => excerpts.has(id)) && (panel.contextExcerptIds ?? []).every(id => contexts.has(id)) && (panel.beatIds ?? []).every(id => beats.has(id)), `コマ ${panel.id} の参照が不正です`);
      check(Array.isArray(panel.characters) && Array.isArray(panel.texts), `コマ ${panel.id} の人物・台詞が不正です`);
      check(new Set(panel.characters.map(c => c.characterId)).size === panel.characters.length, `コマ ${panel.id} の人物が重複しています`);
      const scene = episode.scenes.find(x => x.id === panel.sceneId);
      for (const character of panel.characters) {
        check(characters.has(character.characterId), `コマ ${panel.id} の人物がありません`);
        check(optionalId(character.appearanceId) && (character.appearanceId == null || scene?.appearances?.some(a => a.id === character.appearanceId && a.characterId === character.characterId)), `コマ ${panel.id} の衣装が一致しません`);
      }
      ids(panel.texts, '台詞');
      for (const entry of panel.texts) { text(entry.text, '台詞'); check(optionalId(entry.speakerId) && (entry.speakerId == null || characters.has(entry.speakerId)), '台詞の話者がありません'); }
      frame(panel.frame);
    }
  }
  return episode;
}

export function splitEpisodeFiles(episode, selectedPageIds = episode.pageIds) {
  validateEpisode(episode);
  check(selectedPageIds.every(id => episode.pageIds.includes(id)), '書出しページがありません');
  const { pages, ...manifest } = episode;
  return { manifest: copy(manifest), pages: Object.fromEntries(selectedPageIds.map(id => [id, copy(pages.find(p => p.id === id))])) };
}

export function joinEpisodeFiles(manifest, pages) {
  check(object(manifest) && manifest.format === PAGE_FORMAT && Array.isArray(manifest.pageIds), '話の索引が不正です');
  check(object(pages), 'ページファイルが不正です');
  const included = manifest.pageIds.filter(id => Object.hasOwn(pages, id));
  check(Object.keys(pages).every(id => included.includes(id) && pages[id]?.id === id), 'ページファイルのIDが索引と一致しません');
  // A partial transfer keeps the provider order as metadata, without requiring omitted files.
  return validateEpisode({ ...copy(manifest), pageIds: included, pages: included.map(id => copy(pages[id])) });
}

function applyPageOperation(page, operation, makeId) {
  const find = id => { const index = page.panels.findIndex(p => p.id === id); check(index !== -1, `コマ ${id} がありません`); return index; };
  const index = operation.panelId ? find(operation.panelId) : -1;
  switch (operation.type) {
    case 'updatePanel': {
      const allowed = ['sceneId', 'sourceExcerptIds', 'contextExcerptIds', 'beatIds', 'characters', 'prompt', 'shotIntent', 'protect', 'gaze', 'intent', 'previousPanelId'];
      check(object(operation.changes) && Object.keys(operation.changes).every(key => allowed.includes(key)), 'コマの変更項目が不正です');
      page.panels[index] = { ...page.panels[index], ...copy(operation.changes) }; break;
    }
    case 'updateText': {
      const panel = page.panels[index], entry = panel.texts.find(t => t.id === operation.textId);
      check(entry && object(operation.changes) && Object.keys(operation.changes).every(key => ['text', 'kind', 'speakerId', 'box', 'style'].includes(key)), '台詞の変更対象が不正です');
      Object.assign(entry, copy(operation.changes)); break;
    }
    case 'insertText': {
      const entries = page.panels[index].texts;
      check(object(operation.text) && ID.test(operation.text.id) && !entries.some(entry => entry.id === operation.text.id) &&
        Number.isInteger(operation.index) && operation.index >= 0 && operation.index <= entries.length, '台詞のID・位置が不正です');
      entries.splice(operation.index, 0, copy(operation.text)); break;
    }
    case 'removeText': {
      const entries = page.panels[index].texts, at = entries.findIndex(entry => entry.id === operation.textId);
      check(at >= 0, '台詞がありません'); entries.splice(at, 1); break;
    }
    case 'insertPanel': {
      check(Number.isInteger(operation.index) && operation.index >= 0 && operation.index <= page.panels.length, '挿入位置が不正です');
      const panel = { ...copy(operation.panel), id: operation.panel?.id ?? makeId(), frame: operation.panel?.frame ?? null };
      check(!page.panels.some(p => p.id === panel.id), 'コマIDが重複しています');
      page.panels.splice(operation.index, 0, panel); break;
    }
    case 'removePanel': page.panels.splice(index, 1); break;
    case 'splitPanel': {
      const original = page.panels[index], panel = { ...copy(original), ...copy(operation.newPanel ?? {}), id: operation.newPanel?.id ?? makeId(), frame: operation.newPanel?.frame ?? null, texts: [] };
      check(!page.panels.some(p => p.id === panel.id), 'コマIDが重複しています');
      const moving = new Set(operation.moveTextIds ?? []);
      check([...moving].every(id => original.texts.some(t => t.id === id)), '移動する台詞がありません');
      panel.texts = original.texts.filter(t => moving.has(t.id));
      original.texts = original.texts.filter(t => !moving.has(t.id));
      if (operation.frame !== undefined) original.frame = copy(operation.frame);
      page.panels.splice(index + 1, 0, panel); break;
    }
    case 'mergePanels': {
      const others = operation.otherPanelIds ?? [];
      check(others.length && new Set(others).size === others.length && !others.includes(operation.panelId), '統合するコマが不正です');
      const panels = others.map(id => page.panels[find(id)]);
      const kept = page.panels[index];
      kept.texts.push(...panels.flatMap(p => p.texts));
      check(new Set(kept.texts.map(t => t.id)).size === kept.texts.length, '統合後の台詞IDが重複しています');
      page.panels = page.panels.filter(p => !others.includes(p.id)); break;
    }
    case 'reorderPanels': {
      check(Array.isArray(operation.panelIds) && operation.panelIds.length === page.panels.length && new Set(operation.panelIds).size === page.panels.length && operation.panelIds.every(id => page.panels.some(p => p.id === id)), 'コマ順が不正です');
      page.panels = operation.panelIds.map(id => page.panels.find(p => p.id === id)); break;
    }
    case 'setFrames': {
      check(object(operation.frames) && Object.keys(operation.frames).every(id => page.panels.some(p => p.id === id)), '対象外のコマ枠です');
      for (const panel of page.panels) if (Object.hasOwn(operation.frames, panel.id)) panel.frame = copy(operation.frames[panel.id]);
      break;
    }
    default: throw Error(`許可されていないページ操作: ${operation.type}`);
  }
}

export function editNamePage(episode, pageId, operations, makeId = () => crypto.randomUUID()) {
  validateEpisode(episode);
  check(Array.isArray(operations), 'ページ操作が不正です');
  const next = copy(episode), page = next.pages.find(p => p.id === pageId);
  check(page, `ページ ${pageId} がありません`);
  for (const operation of operations) applyPageOperation(page, operation, makeId);
  return validateEpisode(next);
}

export function editPageList(episode, operation) {
  validateEpisode(episode);
  const next = copy(episode);
  if (operation.type === 'addPage') {
    check(object(operation.page) && !next.pageIds.includes(operation.page.id) && Number.isInteger(operation.index) && operation.index >= 0 && operation.index <= next.pageIds.length, '新ページのID・位置が不正です');
    next.pageIds.splice(operation.index, 0, operation.page.id);
    next.pages.push(copy(operation.page));
  } else if (operation.type === 'removePage') {
    check(next.pageIds.includes(operation.pageId), '削除するページがありません');
    next.pageIds = next.pageIds.filter(id => id !== operation.pageId);
    next.pages = next.pages.filter(p => p.id !== operation.pageId);
  } else if (operation.type === 'reorderPages') {
    check(Array.isArray(operation.pageIds) && operation.pageIds.length === next.pageIds.length &&
      new Set(operation.pageIds).size === next.pageIds.length && operation.pageIds.every(id => next.pageIds.includes(id)), 'ページ順が不正です');
    next.pageIds = [...operation.pageIds];
  } else throw Error(`許可されていないページ管理操作: ${operation.type}`);
  return validateEpisode(next);
}

export function editNameScene(episode, sceneId, operations) {
  validateEpisode(episode);
  const next = copy(episode), scene = next.scenes.find(s => s.id === sceneId);
  check(Array.isArray(operations), 'シーン操作が不正です');
  for (const op of operations) {
    if (op.type === 'createScene') { check(!scene && op.scene?.id === sceneId, 'シーンIDが不正です'); next.scenes.push(copy(op.scene)); }
    else {
      const current = next.scenes.find(s => s.id === sceneId);
      check(current, 'シーンがありません');
      if (op.type === 'updateScene') { check(object(op.changes) && !Object.hasOwn(op.changes, 'id') && !Object.hasOwn(op.changes, 'appearances'), 'シーンの変更項目が不正です'); Object.assign(current, copy(op.changes)); }
      else if (op.type === 'addAppearance') { check(op.appearance?.id && !current.appearances.some(a => a.id === op.appearance.id), '衣装IDが重複しています'); current.appearances.push(copy(op.appearance)); }
      else if (op.type === 'updateAppearance') { const appearance = current.appearances.find(a => a.id === op.appearanceId); check(appearance && object(op.changes) && !Object.hasOwn(op.changes, 'id') && !Object.hasOwn(op.changes, 'characterId'), '衣装の変更項目が不正です'); Object.assign(appearance, copy(op.changes)); }
      else if (op.type === 'removeAppearance' || op.type === 'removeScene') {
        for (const page of next.pages) for (const panel of page.panels) {
          if (panel.sceneId !== sceneId) continue;
          if (op.type === 'removeScene') { panel.sceneId = null; for (const character of panel.characters) character.appearanceId = null; }
          else for (const character of panel.characters) if (character.appearanceId === op.appearanceId) character.appearanceId = null;
        }
        if (op.type === 'removeScene') next.scenes = next.scenes.filter(s => s.id !== sceneId);
        else current.appearances = current.appearances.filter(a => a.id !== op.appearanceId);
      } else throw Error(`許可されていないシーン操作: ${op.type}`);
    }
  }
  return validateEpisode(next);
}

export function affectedByAppearance(episode, sceneId, appearanceId) {
  return episode.pageIds.flatMap((pageId, index) => (episode.pages.find(p => p.id === pageId)?.panels ?? [])
    .filter(panel => panel.sceneId === sceneId && panel.characters.some(c => c.appearanceId === appearanceId))
    .map(panel => ({ pageId, pageNumber: index + 1, panelId: panel.id })));
}

export function adoptPages(current, incoming, selectedPageIds, { positions = {}, sharedIds = {} } = {}) {
  validateEpisode(current); validateEpisode(incoming);
  check(current.workId === incoming.workId && current.episodeId === incoming.episodeId, '別の作品・話は取り込めません');
  check(Array.isArray(selectedPageIds) && selectedPageIds.length && new Set(selectedPageIds).size === selectedPageIds.length, '取込みページを選んでください');
  const next = copy(current);
  for (const key of ['characters', 'beats', 'scenes']) {
    const allowed = new Set(sharedIds[key] ?? []);
    for (const item of incoming[key] ?? []) {
      const index = next[key].findIndex(existing => existing.id === item.id);
      if (index === -1) next[key].push(copy(item));
      else if (allowed.has(item.id)) next[key][index] = copy(item);
      else if (key === 'scenes') {
        const existing = next[key][index], known = new Set((existing.appearances ?? []).map(a => a.id));
        existing.appearances = [...(existing.appearances ?? []), ...(item.appearances ?? []).filter(a => !known.has(a.id)).map(copy)];
      }
    }
  }
  for (const id of selectedPageIds) {
    const page = incoming.pages.find(p => p.id === id);
    check(page, `選択したページ ${id} がありません`);
    const other = next.pages.filter(p => p.id !== id);
    check(page.panels.every(panel => !other.some(p => p.panels.some(x => x.id === panel.id))), `コマ ${id} が別のページに移されています`);
    const index = next.pages.findIndex(p => p.id === id);
    if (index < 0) {
      check(Number.isInteger(positions[id]) && positions[id] >= 0 && positions[id] <= next.pageIds.length, `新ページ ${id} の挿入位置を選んでください`);
      next.pageIds.splice(positions[id], 0, id); next.pages.push(copy(page));
    } else next.pages[index] = copy(page);
  }
  return validateEpisode(next);
}

export function buildPageEditContext(episode, pageId, relatedEpisodes = []) {
  validateEpisode(episode);
  const at = episode.pageIds.indexOf(pageId); check(at !== -1, 'ページがありません');
  const target = episode.pages.find(p => p.id === pageId);
  const lookup = id => episode.pages.find(p => p.id === id) ?? relatedEpisodes.flatMap(e => e.pages ?? []).find(p => p.id === id);
  const neighbor = (side, offset) => {
    const boundary = target.boundaryContext?.[side];
    if (boundary?.relatedPageId) return lookup(boundary.relatedPageId) ?? { ...boundary, from: 'creation-context' };
    return lookup(episode.pageIds[at + offset]) ?? (boundary ? { ...boundary, from: 'creation-context' } : null);
  };
  return { workGoal: copy(episode.workGoal ?? null), beats: copy(episode.beats), page: copy(target), previous: copy(neighbor('before', -1)), next: copy(neighbor('after', 1)), scenes: copy(episode.scenes) };
}

export function resolvePanelDirection(episode, pageId, panelId) {
  validateEpisode(episode);
  const page = episode.pages.find(p => p.id === pageId), panel = page?.panels.find(p => p.id === panelId);
  check(panel, '対象コマがありません');
  const scene = episode.scenes.find(s => s.id === panel.sceneId) ?? null;
  return { workId: episode.workId, episodeId: episode.episodeId, pageId, panelId,
    pagePurpose: page.purpose ?? '', scene: copy(scene), prompt: panel.prompt ?? '', shotIntent: panel.shotIntent ?? '', protect: copy(panel.protect ?? []),
    characters: panel.characters.map(character => ({ ...copy(character), appearance: copy(scene?.appearances?.find(a => a.id === character.appearanceId) ?? null) })),
    texts: copy(panel.texts), frame: copy(panel.frame) };
}

export function nameRevision(episode, reason, at = new Date().toISOString(), id = crypto.randomUUID()) {
  validateEpisode(episode); check(ID.test(id), '版IDが不正です');
  return { id, at, reason, workId: episode.workId, episodeId: episode.episodeId, episode: copy(episode) };
}
export function restoreNameRevision(current, revision) {
  validateEpisode(current);
  check(revision?.workId === current.workId && revision?.episodeId === current.episodeId, '別の話の版は復元できません');
  validateEpisode(revision.episode);
  return copy(revision.episode);
}
