import { emptyProject } from './core.js';
import { validateLayout, pagePanels, PAGE } from './layout.js';
import { setLettering, validateLettering } from './lettering.js';
import { sealSnapshots, validateApplication } from './source-application.js';
import { digest, imageHash, adoptCandidate } from './revisions.js';
import { producePanels } from './production.js';
import { generatePanel } from './pipeline.js';
import { recoverImageResult } from './image-recovery.js';
import { pagePNG } from './render.js';
import { imageModel } from './media.js';
import { createNameFile, createNameCandidate, adoptNameCandidate, validateV2State, localNamePlan } from './name-v2.js';
import { finalizeNameApplication } from './name-v2-production.js';
import { atomize } from '../contracts/name-plan/source.mjs';
import { compileNameLayout } from '../contracts/name-plan/layout.mjs';
import { FORMAT, COMPILER_VERSION, canonical as canonicalName, sha256 } from '../contracts/name-plan/schema.mjs';

export const ACCEPTANCE_FIXTURE = 'manga-mac/acceptance-fixture/v1';
export const ACCEPTANCE_MODEL = 'flux-2-klein-4b-q6-local';
export const ACCEPTANCE_SIZE = Object.freeze([256, 256]);
const TEXT = 'こんにちは。文字と保存の確認です。';
export const ACCEPTANCE_STAGES = Object.freeze([
  ['name_v2_compiler', 'ネームAI v2で1ページを組版'],
  ['fixture_save', '確認用作品の保存'], ['fixture_reload', '保存内容の再読込'],
  ['generation', 'ローカル画像を1枚生成'], ['adoption', '画像・文字・原稿対応を保存'],
  ['renderer', '日本語付きページを描画'], ['export_png', 'PNGを書き出し'],
  ['restart', 'アプリを終了・再起動して照合'],
  ['visual_review', '画像・文字品質の目視確認'], ['p01_review', 'P01実原稿の確認'],
]);

export async function createAcceptanceFixture() {
  const snapshot = { id: 'acceptance-source', repo: 'acceptance/fixture', sha: '0'.repeat(40),
    scenes: [{ id: 'acceptance-scene', text: TEXT }], settings: [], references: [] };
  await sealSnapshots([snapshot]);
  const base = { ...emptyProject(), version: 5, acceptanceFixture: ACCEPTANCE_FIXTURE,
    title: '最小制作確認', workId: 'acceptance-fixture-v1', active: snapshot.id,
    snapshots: [snapshot], panels: [],
    layout: { version: 1, pages: [], knownPanelIds: [] },
    sourceApplication: { version: 1, units: [] }, mediaDefaults: { ...emptyProject().mediaDefaults, image: ACCEPTANCE_MODEL } };
  const atoms = atomize(snapshot), atomIds = atoms.map(atom => atom.id);
  const plan = {
    workGoal: { readerQuestion: '文字が読めるか', emotionalArc: ['確認'], payoff: '短い日本語を読める' },
    coverage: atoms.map(atom => ({ atomId: atom.id, presentation: 'narration', reason: '確認原稿を省略せず掲載する' })),
    beats: [{ id: 'b1', atomIds, function: 'setup', tempo: 'normal', readerBefore: '確認前', readerAfter: '確認後' }],
    panels: [{ id: 'p1', atomIds, contextAtomIds: [], beatIds: ['b1'], characterIds: [], role: 'standard', shot: 'wide', shotIntent: '一本の木と静かな道',
      prompt: 'A simple small tree beside a quiet path, clear black ink manga illustration.', silentReason: '', protect: ['木'], gaze: 'neutral' }],
    pages: [{ id: 'page1', purpose: '日本語と作画の保存を確認する', entryBeatId: 'b1', exit: { kind: 'pause', note: '確認終了', payoffBeatIds: [] }, tree: { type: 'leaf', panelId: 'p1' } }],
  };
  const file = await createNameFile(base, plan, atomIds, { producer: 'acceptance-fixture', model: '', editedBy: [] }, {embedded:false});
  return adoptNameCandidate(base, await createNameCandidate(base, file, { namespace: 'acceptance' }));
}

export function assertAcceptanceProject(project) {
  if (project?.acceptanceFixture !== ACCEPTANCE_FIXTURE || project.workId !== 'acceptance-fixture-v1'
    || project.snapshots?.length !== 1 || project.snapshots[0].id !== 'acceptance-source'
    || project.active !== 'acceptance-source' || project.snapshots[0].scenes?.length !== 1
    || project.snapshots[0].scenes[0].text !== TEXT || project.characters?.length !== 0
    || project.panels?.length !== 1 || project.namePlan?.format !== FORMAT
    || project.namePlan.status !== 'adopted' || project.namePlan.namespace !== 'acceptance'
    || project.namePlan.panelIds?.length !== 1 || project.panels[0].id !== project.namePlan.panelIds[0]
    || project.mediaDefaults?.image !== ACCEPTANCE_MODEL || project.mediaDefaults?.imageConnection
    || project.layout?.pages?.length !== 1 || project.layout.pages[0].slots?.length !== 1) {
    throw Error('専用の確認用作品ではありません。保存・生成を停止しました。');
  }
  validateLayout(project.layout, project.panels);
  validateLettering(project.panels[0], project.panels[0].lettering);
  validateApplication(project);
  validateV2State(project);
  const compiled = compileNameLayout(localNamePlan(project.namePlan.file, project.namePlan.namespace), project.namePlan.profile, project.namePlan.metrics);
  if (project.namePlan.compilerVersion !== COMPILER_VERSION || project.namePlan.geometryOverride
    || canonicalName(compiled.layout) !== canonicalName(project.namePlan.compiledLayout)
    || canonicalName(compiled.layout) !== canonicalName(project.layout)) throw Error('確認用ネームとv2コンパイラの配置が一致しません。');
  return project;
}

// Native JSON object order differs from JavaScript. Hash semantic data, with
// stable ordering, rather than a serialized transport envelope/content token.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function acceptanceProjectHash(project) {
  const keys = ['acceptanceFixture', 'workId', 'active', 'snapshots', 'panels', 'layout', 'namePlan', 'sourceApplication', 'artworks', 'jobs', 'mediaDefaults', 'output_locale'];
  return digest(new TextEncoder().encode(JSON.stringify(canonical(Object.fromEntries(keys.map(key => [key, project[key]]))))));
}

function generationEvidence(panel) {
  const model = imageModel(ACCEPTANCE_MODEL), g = panel.generation;
  if (model.locality !== 'local' || model.input.steps !== 4 || !g || g.registry_id !== ACCEPTANCE_MODEL
    || g.model !== model.model_id || g.width !== 256 || g.height !== 256 || g.steps !== 4) {
    throw Error('生成結果のモデル・寸法・ステップ数が確認条件と一致しません。');
  }
  return { modelId: ACCEPTANCE_MODEL, width: g.width, height: g.height, steps: g.steps, seed: g.seed };
}

export function createAcceptanceSession({ context, load, save, invoke, generate = generatePanel,
  render = pagePNG, onProject = () => {}, onStages = () => {}, onPreview = () => {}, onReportPath = () => {}, notify = () => {} }) {
  if (!context || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.sessionId ?? '')) throw Error('実機確認セッションが不正です。');
  let project = null;
  const stages = structuredClone(context.stages ?? {});
  const restartBaseline = structuredClone(context.stages?.adoption ?? null);
  async function record(stage, status, evidence = {}) {
    const saved = await invoke('acceptance_record_stage', { stage, status, evidence });
    stages[stage] = { status, evidence, ...(typeof saved?.next === 'string' ? { next: saved.next } : {}) };
    onStages({ ...stages });
  }
  async function stage(name, action) {
    try { const result = await action(); await record(name, 'PASS', result?.evidence ?? {}); return result?.value; }
    catch (error) { await record(name, 'FAIL'); throw error; }
  }
  async function read() {
    const next = await load();
    project = next ? assertAcceptanceProject(next) : null;
    onProject(project);
    return project;
  }
  async function commit(value) {
    const next = typeof value === 'function' ? value(project) : value;
    project = assertAcceptanceProject(await save(assertAcceptanceProject(next)));
    onProject(project);
    return project;
  }
  const pending = () => project?.jobs?.find(job => ['running', 'unknown', 'candidate'].includes(job.status));
  async function compareReload() {
    const expected = await acceptanceProjectHash(project);
    await read();
    if (!project || await acceptanceProjectHash(project) !== expected) throw Error('保存前後で作品内容が変わりました。');
    return { evidence: { projectSha256: expected, panelCount: 1, pageCount: 1 } };
  }
  async function finishPage() {
    try {
      const panel = project.panels[0];
      const job = project.jobs.find(item => item.status === 'complete' && item.output_revision === panel.artwork_revision);
      if (!panel.image || !job || pending()) throw Error('採用済み作画を確認できません。保存済み結果を回収してください。');
      generationEvidence(panel);
      if (panel.letteringStatus !== 'ready' || panel.letteringArtworkRevision !== panel.artwork_revision) await commit(setLettering(project, panel.id, panel.lettering));
    } catch (error) { await record('adoption', 'FAIL'); throw error; }
    const image = await stage('renderer', async () => {
      const page = project.layout.pages[0];
      const image = await render(pagePanels(project, page), project.snapshots, project.localizations, project.output_locale, page, false, project.layout.imageCrops);
      onPreview(image);
      return { value: image, evidence: { sha256: await imageHash(image), width: PAGE.width, height: PAGE.height } };
    });
    await stage('adoption', async () => {
      // Match ordinary v2 production: only a successful strict page render can
      // finalize source application. Reusing an accepted page is idempotent.
      if (project.namePlan.productionState !== 'proof-ready') await commit(finalizeNameApplication(project));
      validateV2State(project, { complete: true });
      await compareReload();
      return { evidence: { projectSha256: await acceptanceProjectHash(project), imageSha256: await imageHash(project.panels[0].image), panelCount: 1, pageCount: 1 } };
    });
    await stage('export_png', async () => {
      const result = await invoke('acceptance_export', { image });
      if (result.sha256 !== await imageHash(image) || result.width !== PAGE.width || result.height !== PAGE.height || !Number.isSafeInteger(result.bytes) || result.bytes <= 0) throw Error('書き出したPNGのハッシュ・寸法が一致しません。');
      return { evidence: result };
    });
    const report = await invoke('acceptance_finish');
    if (report?.reportPath) onReportPath(report.reportPath);
    notify('保存・PNG出力を確認しました。アプリを終了し、同じセッションで再起動してください。');
  }
  return {
    load: read,
    async run() {
      await read();
      if (pending()) throw Error('未確定の要求があります。「保存済み結果を回収」を使ってください。再生成は行いません。');
      project = await stage('name_v2_compiler', async () => {
        const fixture = assertAcceptanceProject(project ?? await createAcceptanceFixture());
        if (await sha256(fixture.namePlan.file) !== fixture.namePlan.fileHash) throw Error('保存したネームJSONのハッシュが一致しません。');
        return { value: fixture, evidence: { sha256: fixture.namePlan.fileHash, panelCount: 1, pageCount: 1 } };
      });
      await stage('fixture_save', async () => {
        await commit(project);
        return { evidence: { projectSha256: await acceptanceProjectHash(project), panelCount: 1, pageCount: 1 } };
      });
      await stage('fixture_reload', compareReload);
      if (!project.panels[0].image) {
        try {
          await producePanels({ current: () => project, commit, panelIds: [project.panels[0].id], imageModelId: ACCEPTANCE_MODEL, notify,
            generate: (...args) => stage('generation', async () => {
              const start = performance.now();
              const generated = await generate(...args, { resolution: [...ACCEPTANCE_SIZE] });
              return { value: generated, evidence: { ...generationEvidence(generated), imageSha256: await imageHash(generated.image), elapsedMs: Math.round(performance.now() - start) } };
            }) });
        } catch (error) {
          if (stages.generation?.status === 'PASS') await record('adoption', 'FAIL');
          throw error;
        }
      }
      await finishPage();
    },
    async recover() {
      await read();
      if (!project) throw Error('回収する確認用作品がありません。');
      const job = pending();
      if (!job || !['unknown', 'candidate'].includes(job.status)) throw Error('回収する保存済み要求がありません。');
      if (job.status === 'unknown') {
        // Existing native receipt/hash checks are the only recovery path.
        const receipt = await invoke('recover_image', { jobId: job.id });
        await commit(await recoverImageResult(project, job.id, receipt));
      }
      await commit(await adoptCandidate(project, job.id));
      await record('generation', 'PASS', { ...generationEvidence(project.panels[0]), imageSha256: await imageHash(project.panels[0].image) });
      await finishPage();
    },
    async verifyRestart() {
      if (!context.resumed) throw Error('同じセッションでアプリを終了・再起動してから確認してください。');
      await stage('restart', async () => {
        const baseline = restartBaseline;
        if (baseline?.status !== 'PASS' || !baseline.evidence?.projectSha256 || !baseline.evidence?.imageSha256) throw Error('再起動前の保存済み作画の記録がありません。');
        await read();
        if (!project || pending() || await acceptanceProjectHash(project) !== baseline.evidence.projectSha256
          || await imageHash(project.panels[0].image) !== baseline.evidence.imageSha256) throw Error('再起動前後で保存内容が一致しません。');
        return { evidence: baseline.evidence };
      });
      const report = await invoke('acceptance_finish');
      if (report?.reportPath) onReportPath(report.reportPath);
      notify('再起動前後の作品・画像ハッシュが一致しました。目視品質・P01確認は未実施です。');
    },
  };
}
