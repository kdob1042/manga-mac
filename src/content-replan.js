import {validateApplication} from './source-application.js';
import { sourceUnits, validatePlan } from './core.js';
import { layoutWarnings, reflowLayout, validateLayout } from './layout.js';
import { digest } from './revisions.js';

// Content replanning is deliberately separate from layout AI. The model only
// returns a new grouping of immutable source units; page geometry is rebuilt
// deterministically after the candidate is adopted.
export const contentReplanSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          unitIds: { type: 'array', items: { type: 'string' } },
          prompt: { type: 'string' },
          characterIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['unitIds', 'prompt', 'characterIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['reason', 'panels'],
  additionalProperties: false,
};

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function activeSnapshot(project) {
  const snapshot = project.snapshots?.find((item) => item.id === project.active);
  if (!snapshot) throw Error('再計画する原作がありません');
  return snapshot;
}

function sceneSelection(project, sceneIds) {
  const snapshot = activeSnapshot(project);
  if (!Array.isArray(sceneIds) || !sceneIds.length || new Set(sceneIds).size !== sceneIds.length) {
    throw Error('再計画する場面を選んでください');
  }
  return sceneIds.map((id) => {
    const scene = snapshot.scenes?.find((item) => item.id === id);
    if (!scene) throw Error(`再計画する場面がありません: ${id}`);
    return scene;
  });
}

// The base excludes the job record and revision counter so saving a running
// candidate cannot make its own input stale. Artwork bytes are represented by
// a digest, keeping candidate jobs small while still detecting image changes.
export async function contentBase(project) {
  const snapshot = activeSnapshot(project);
  const panels = await Promise.all((project.panels ?? []).map(async (panel) => {
    const { image, ...rest } = panel;
    return { ...rest, imageHash: image ? await digest(new TextEncoder().encode(image)) : null };
  }));
  const source = {
    id: snapshot.id,
    sha: snapshot.sha ?? null,
    scenes: (snapshot.scenes ?? []).map(({ id, text, design }) => ({ id, text, design })),
  };
  return digest(new TextEncoder().encode(JSON.stringify({
    active: project.active,
    source,
    panels,
    layout: project.layout,
    draftScope: project.draftScope ?? null,
  })));
}

function sceneContext(project, scene) {
  const snapshot = activeSnapshot(project);
  const oldPanels = project.panels.filter((panel) => panel.sceneId === scene.id);
  if (!oldPanels.length) throw Error(`${scene.id} に既存コマがありません`);
  if (oldPanels.some((panel) => panel.snapshotId !== snapshot.id)) {
    throw Error(`${scene.id} は現在の原作版で作られたコマではありません。別の初稿を作ってください`);
  }
  const units = sourceUnits(scene.id, scene.text);
  const unitIds = units.map((unit) => unit.id);
  if (!equal(oldPanels.flatMap((panel) => panel.unitIds ?? []), unitIds)) {
    throw Error(`${scene.id} の既存コマは原文unitを完全には参照していません`);
  }

  return {snapshot,scene,units,oldPanels,mutableOldPanels:oldPanels,mutableUnits:units};
}

function planMatchesPanel(panel, plan) {
  return equal(panel.unitIds, plan.unitIds) && panel.prompt === plan.prompt && equal(panel.characterIds, plan.characterIds);
}

function validateResponse(response, units, characters) {
  if (!response || typeof response.reason !== 'string' || !response.reason.trim() || response.reason.length > 2000) {
    throw Error('AIの内容再計画応答が不正です');
  }
  const panels = validatePlan(response, units, characters);
  return { reason: response.reason.trim(), panels: panels.map((panel) => ({
    unitIds: [...panel.unitIds],
    prompt: panel.prompt,
    characterIds: [...panel.characterIds],
  })) };
}

function replanPrompt(context, instruction) {
  return JSON.stringify({
    task: '既存コマの内容分割だけを再計画する。ページ、枠形状、画像、文字配置、3D構図、動画は変更しない。',
    constraints: [
      'mutableUnits のunitIdsを全て一度ずつ、原文の順序のまま割り当てる',
      'unitの本文を創作・省略・並べ替えしない',
      '関連する複数unitを一つのコマへまとめてもよい。コマを分割してもよい',
      'characterIdsは登録済み人物だけを使い、不要な人物を推測しない',
      'ページ配置の案や画像生成の指示は返さない',
    ],
    instruction,
    scene: { id: context.scene.id, design: context.scene.design ?? '' },
    currentPanels: context.mutableOldPanels.map((panel) => ({
      id: panel.id,
      unitIds: panel.unitIds,
      prompt: panel.prompt,
      characterIds: panel.characterIds,
      hasImage: !!panel.image,
    })),
    mutableUnits: context.mutableUnits,
  });
}

function sceneCandidate(context, response, jobId) {
  const used = new Set();
  const panels = [];
  for (const [index, plan] of response.panels.entries()) {
    const old = context.mutableOldPanels.find((panel) => !used.has(panel.id) && planMatchesPanel(panel, plan));
    if (old) {
      used.add(old.id);
      panels.push({
        id: old.id,
        unitIds: [...plan.unitIds],
        prompt: plan.prompt,
        characterIds: [...plan.characterIds],
        reusePanelId: old.id,
        redraw: false,
      });
    } else {
      panels.push({
        id: `content:${jobId}:${context.scene.id}:p${index}`,
        unitIds: [...plan.unitIds],
        prompt: plan.prompt,
        characterIds: [...plan.characterIds],
        reusePanelId: null,
        redraw: true,
      });
    }
  }
  return {
    sceneId: context.scene.id,
    reason: response.reason,
    oldPanelIds: context.oldPanels.map((panel) => panel.id),
    retainedPanelIds: panels.filter((panel) => panel.reusePanelId).map((panel) => panel.id),
    redrawPanelIds: panels.filter((panel) => panel.redraw).map((panel) => panel.id),
    panels,
  };
}

function panelFromCandidate(panel, sceneId, snapshotId, existingIds) {
  if (existingIds.has(panel.id)) throw Error('内容再計画案のコマIDが既存コマと衝突しています');
  return {
    id: panel.id,
    sceneId,
    snapshotId,
    unitIds: [...panel.unitIds],
    prompt: panel.prompt,
    characterIds: [...panel.characterIds],
    image: null,
    status: 'planned',
    instructions: [],
    attempts: 0,
    capture_revision: null,
    artwork_revision: null,
  };
}

function candidatePanelPlan(panel) {
  if (!panel || typeof panel.id !== 'string' || !Array.isArray(panel.unitIds) || !panel.unitIds.length || typeof panel.prompt !== 'string' || !Array.isArray(panel.characterIds) || (typeof panel.reusePanelId !== 'string' && panel.reusePanelId !== null) || typeof panel.redraw !== 'boolean') {
    throw Error('保存された内容再計画案が不正です');
  }
  return panel;
}

function materializeScene(project, context, scenePlan, allCurrentIds) {
  if (!scenePlan || scenePlan.sceneId !== context.scene.id || !Array.isArray(scenePlan.panels) || !scenePlan.panels.length || !Array.isArray(scenePlan.oldPanelIds) || !Array.isArray(scenePlan.retainedPanelIds) || !Array.isArray(scenePlan.redrawPanelIds)) throw Error('保存された内容再計画案が不正です');
  const oldById = new Map(context.oldPanels.map((panel) => [panel.id, panel]));
  const seen = new Set();
  const panels = scenePlan.panels.map((raw) => {
    const panel = candidatePanelPlan(raw);
    if (seen.has(panel.id)) throw Error('内容再計画案のコマIDが重複しています');
    seen.add(panel.id);
    if (panel.redraw !== !panel.reusePanelId) throw Error('再作画対象の記録が不正です');
    if (panel.reusePanelId) {
      const old = oldById.get(panel.reusePanelId);
      if (!old || panel.id !== old.id || !planMatchesPanel(old, panel)) throw Error('保持するコマの内容が現在の原稿と一致しません');
      return structuredClone(old);
    }
    return panelFromCandidate(panel, context.scene.id, context.snapshot.id, allCurrentIds);
  });
  const actual = panels.flatMap((panel) => panel.unitIds);
  const expected = context.units.map((unit) => unit.id);
  if (!equal(actual, expected)) throw Error('内容再計画案が原文unitの完全性・順序を満たしていません');
  const expectedRetained = panels.filter((panel) => context.oldPanels.some((old) => old.id === panel.id)).map((panel) => panel.id);
  const expectedRedraw = panels.filter((panel) => !context.oldPanels.some((old) => old.id === panel.id)).map((panel) => panel.id);
  if (!equal(scenePlan.oldPanelIds, context.oldPanels.map((panel) => panel.id)) || !equal(scenePlan.retainedPanelIds, expectedRetained) || !equal(scenePlan.redrawPanelIds, expectedRedraw)) throw Error('内容再計画案の変更対象記録が不正です');
  return panels;
}

function reflowForContent(project, nextPanels, removedIds, redrawPanelIds) {
  const oldIds = new Set(project.panels.map((panel) => panel.id));
  const nextIds = new Set(nextPanels.map((panel) => panel.id));
  const changed = [...oldIds].some((id) => !nextIds.has(id)) || [...nextIds].some((id) => !oldIds.has(id));
  if (!changed) return { layout: structuredClone(project.layout), summary: { changed: false, firstAffectedPageIndex: -1, affectedPageIds: [], redrawPanelIds } };
  const firstRemoved = project.panels.find((panel) => removedIds.has(panel.id));
  const firstPageIndex = project.layout.pages.findIndex((page) => page.slots.some((slot) => slot.panelId === firstRemoved?.id));
  if (firstPageIndex < 0) throw Error('内容変更対象のコマがページに割り当てられていません');
  const cleared = structuredClone(project.layout);
  cleared.pages = cleared.pages.map((page, index) => index >= firstPageIndex ? {
    ...page,
    slots: page.slots.map((slot) => ({ ...slot, panelId: null })),
  } : page);
  const activeIds = new Set(nextPanels.map((panel) => panel.id));
  if (cleared.imageCrops) cleared.imageCrops = Object.fromEntries(Object.entries(cleared.imageCrops).filter(([id]) => activeIds.has(id)));
  cleared.knownPanelIds = [...activeIds];
  const nextProject = { ...project, panels: nextPanels, layout: cleared };
  const layout = reflowLayout(nextProject, cleared, firstPageIndex);
  validateLayout(layout, nextPanels);
  const warnings = layoutWarnings(layout, nextPanels);
  if (warnings.length) throw Error(warnings.join(' / '));
  return {
    layout,
    summary: {
      changed: true,
      firstAffectedPageIndex: firstPageIndex,
      affectedPageIds: layout.pages.slice(firstPageIndex).map((page) => page.id),
      redrawPanelIds,
    },
  };
}

export async function materializeContentCandidate(project, candidate) {
  const base = await contentBase(project);
  if (!candidate || candidate.base !== base) throw Error('要求後に原稿が変更されました。現在の原稿から再計画してください');
  const snapshot = activeSnapshot(project);
  if (candidate.snapshotId !== snapshot.id || !Array.isArray(candidate.sceneIds) || !Array.isArray(candidate.scenes)) throw Error('保存された内容再計画案が不正です');
  sceneSelection(project, candidate.sceneIds);
  if (candidate.scenes.length !== candidate.sceneIds.length || !equal(candidate.scenes.map((scene) => scene.sceneId), candidate.sceneIds)) throw Error('保存された内容再計画案の場面範囲が不正です');
  const currentIds = new Set(project.panels.map((panel) => panel.id));
  const replacements = new Map();
  const removedIds = new Set();
  const redrawPanelIds = [];
  for (const scenePlan of candidate.scenes) {
    const context = sceneContext(project, snapshot.scenes.find((scene) => scene.id === scenePlan.sceneId));
    const panels = materializeScene(project, context, scenePlan, currentIds);
    panels.forEach((panel) => currentIds.add(panel.id));
    replacements.set(scenePlan.sceneId, panels);
    context.oldPanels.forEach((panel) => { if (!panels.some((next) => next.id === panel.id)) removedIds.add(panel.id); });
    redrawPanelIds.push(...panels.filter((panel) => !context.oldPanels.some((old) => old.id === panel.id)).map((panel) => panel.id));
  }
  const selected = new Set(candidate.sceneIds), inserted = new Set(), nextPanels = [];
  for (const panel of project.panels) {
    if (!selected.has(panel.sceneId)) {
      nextPanels.push(panel);
    } else if (!inserted.has(panel.sceneId)) {
      nextPanels.push(...replacements.get(panel.sceneId));
      inserted.add(panel.sceneId);
    }
  }
  const { layout, summary } = reflowForContent(project, nextPanels, removedIds, redrawPanelIds);
  if (candidate.summary?.changed !== undefined && candidate.summary.changed !== summary.changed) throw Error('保存された内容再計画案の配置情報が不正です');
  return { panels: nextPanels, layout, summary };
}

export async function proposeContentReplan(project, sceneIds, instruction, ask, jobId = crypto.randomUUID()) {
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000) throw Error('内容再計画の指示を入力してください');
  const contexts = sceneSelection(project, sceneIds).map((scene) => sceneContext(project, scene));
  const characters = project.characters ?? [];
  const scenes = [];
  for (const context of contexts) {
    const response = JSON.parse(await ask(replanPrompt(context, instruction), contentReplanSchema));
    scenes.push(sceneCandidate(context, validateResponse(response, context.mutableUnits, characters), jobId));
  }
  const candidate = {
    type: 'content-replan',
    base: await contentBase(project),
    snapshotId: project.active,
    sceneIds: [...sceneIds],
    instruction,
    reason: scenes.map((scene) => `${scene.sceneId}: ${scene.reason}`).join(' / '),
    scenes,
  };
  const materialized = await materializeContentCandidate(project, candidate);
  if (!materialized.summary.changed) throw Error('AI案に内容の変更がありません');
  return { ...candidate, summary: materialized.summary };
}

export async function saveContentReplan(project, candidate) {
  const materialized = await materializeContentCandidate(project, candidate);
  if (!materialized.summary.changed) throw Error('内容の変更がない候補は保存できません');
  const inputHash = await contentBase(project);
  const id = candidate.jobId ?? crypto.randomUUID();
  return {
    ...project,
    jobs: [...(project.jobs ?? []), {
      id,
      kind: 'content_replan',
      status: 'candidate',
      source_revision: project.active,
      input_hash: inputHash,
      scope: { type: 'content', sceneIds: [...candidate.sceneIds] },
      content_candidate: { ...candidate, base: inputHash },
      at: new Date().toISOString(),
    }],
  };
}

export async function loadContentReplan(project, id) {
  const job = project.jobs?.find((item) => item.id === id && item.kind === 'content_replan');
  if (!job || job.status !== 'candidate' || !job.content_candidate) throw Error('保存された内容再計画候補がありません');
  const base = await contentBase(project);
  if (job.input_hash !== base || job.content_candidate.base !== base) throw Error('原稿が変わった内容再計画候補です');
  const materialized = await materializeContentCandidate(project, job.content_candidate);
  return { ...job.content_candidate, jobId: id, summary: materialized.summary };
}

export function resolveContentReplan(project, id, status) {
  if (!['complete', 'abandoned'].includes(status)) throw Error('内容再計画候補の状態が不正です');
  return { ...project, jobs: project.jobs.map((job) => job.id === id && job.kind === 'content_replan' ? { ...job, status } : job) };
}

export async function adoptContentReplan(project, candidate) {
  const materialized = await materializeContentCandidate(project, candidate);
  const before = {
    ...(project.sourceApplication?{sourceApplication:structuredClone(project.sourceApplication)}:{}),
    panels: structuredClone(project.panels),
    layout: structuredClone(project.layout),
    layoutHistory: structuredClone(project.layoutHistory ?? []),
    layoutRedo: structuredClone(project.layoutRedo ?? []),
  };
  const after = {
    ...(project.sourceApplication?{sourceApplication:{version:1,units:project.sourceApplication.units.filter(unit=>{try{validateApplication({...project,...materialized},[unit]);return true;}catch{return false;}})}}:{}),
    panels: structuredClone(materialized.panels),
    layout: structuredClone(materialized.layout),
    // Old layout history can refer to removed panel IDs. The content-replan
    // history entry is the single safe Undo boundary for this operation.
    layoutHistory: [],
    layoutRedo: [],
  };
  return {
    ...project,
    ...after,
    history: [...(project.history ?? []), {
      contentReplan: true,
      ...before,
      after,
      label: candidate.reason,
      at: new Date().toISOString(),
    }],
    editRedo: [],
  };
}
