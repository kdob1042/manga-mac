import { activeDirection } from './directing.js';
import { affectedScenes, revise } from './core.js';
import {
  draftScenes,
  prepareDraftLayout,
  finishDraftLettering,
  reviewDraft,
} from './draft.js';
import { beginJob, finishJob } from './revisions.js';
import { pagePanels } from './layout.js';
import { recognizeRegions } from './visual-regions.js';

// Application workflow: UI state and external services are supplied by the caller.
export async function produceDraft({
  current,
  commit,
  cancelled,
  model,
  productionMode,
  setBusy,
  setNotice,
  showProof,
  stagePanel,
  planScene,
  generatePanel,
  askLLM,
  imageOf,
  pagePNG,
}) {
  if (!current().active) throw Error('まず原作を接続してください');
  let p = current();
  const snapshot = p.snapshots.find((s) => s.id === p.active),
    scenes = draftScenes(p);
  if (
    p.panels.some(
      (panel) => !snapshot.scenes.some((scene) => scene.id === panel.sceneId),
    )
  )
    throw Error(
      '対象外の場面を含む既存原稿を保持しています。自動初稿では削除しません',
    );
  // Plan all scene content before page geometry or generation; never discard accepted art.
  for (const scene of scenes) {
    if (cancelled()) return;
    let scenePanels = p.panels.filter((x) => x.sceneId === scene.id);
    const old = p.snapshots.find((s) => s.id === scenePanels[0]?.snapshotId);
    if (
      !scenePanels.length ||
      !old ||
      affectedScenes(old, snapshot).includes(scene.id)
    ) {
      if (scenePanels.some((p) => p.image))
        throw Error(
          '原作が変わった場面に採用済み作画があります。旧版を保持しているため、自動初稿では上書きしません',
        );
      setBusy(`${scene.id} の演出を設計中`);
      scenePanels = (await planScene(scene, snapshot, p.characters, model)).map(
        (panel) => ({
          ...panel,
          id: `${p.draftScope?.id ?? crypto.randomUUID()}:${panel.id}`,
        }),
      );
      if (cancelled()) return;
      p = revise(
        current(),
        [
          ...current().panels.filter((x) => x.sceneId !== scene.id),
          ...scenePanels,
        ],
        `${scene.id} の演出計画`,
      );
      p.panels = scenes.flatMap((s) =>
        p.panels.filter((x) => x.sceneId === s.id),
      );
      p = await commit(p);
    }
  }
  await prepareDraftLayout({
    current,
    commit,
    cancelled,
    ask: (prompt, schema) =>
      askLLM(model, { purpose: 'layout', prompt, schema }),
  });
  for (const id of current().panels.map((p) => p.id)) {
    if (cancelled()) break;
    const panel = current().panels.find((p) => p.id === id);
    if (panel.image) continue;
    if (
      productionMode === 'blender' &&
      (!panel.capture_revision || activeDirection(current(), id))
    )
      await stagePanel(id);
    if (cancelled()) break;
    setBusy(`${id} を作画中`);
    p = current();
    const livePanel = p.panels.find((x) => x.id === id),
      job = await beginJob(p, livePanel);
    await commit({ ...p, jobs: [...p.jobs, job] });
    try {
      const generated = await generatePanel(
        livePanel,
        p.characters,
        null,
        '',
        job,
        p.captures?.find((c) => c.id === livePanel.capture_revision),
        p.style_references ?? [],
      );
      await commit(await finishJob(current(), job, generated, cancelled()));
    } catch (e) {
      await commit({
        ...current(),
        jobs: current().jobs.map((j) =>
          j.id === job.id ? { ...j, status: 'unknown' } : j,
        ),
      });
      throw e;
    }
  }
  await finishDraftLettering({
    current,
    commit,
    cancelled,
    notify: setBusy,
    recognize: model.visualEditing
      ? (p, panel) =>
          recognizeRegions(
            p,
            [panel.id],
            '文字配置で顔・手・重要な描写を避ける',
            (prompt, schema, images) =>
              askLLM(model, { purpose: 'vision', prompt, schema, images }),
            imageOf,
          )
      : null,
    check: async (p, id) => {
      const pg = p.layout.pages.find((pg) =>
        pg.slots.some((s) => s.panelId === id),
      );
      await pagePNG(
        pagePanels(p, pg),
        p.snapshots,
        p.localizations,
        p.output_locale,
        pg,
        true,
        p.layout.imageCrops,
      );
    },
    ask: (prompt, schema) =>
      askLLM(model, { purpose: 'lettering', prompt, schema }),
  });
  if (cancelled()) {
    setNotice('停止しました。完成したコマと文字配置は保存済みです');
    return;
  }
  const proofs = await reviewDraft(current(), pagePNG);
  showProof(proofs[0]);
  setNotice(
    `初稿 ${proofs.length}ページを表示しました。人物・衣装・文字の読みやすさを確認し、下の欄か手動で修正できます。`,
  );
}
