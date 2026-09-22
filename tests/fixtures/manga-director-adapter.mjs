// TEST DOUBLE ONLY. This is NOT the #253 name-plan/v2 validator or a live LLM.
import { digest } from '../../tools/manga-director/data.mjs';
export const ORIGINAL = 'アキがレンを見つける。\n\nアキが声をかける。';
export const INSERTION = 'アキは一度ためらい、それから一歩近づく。\n\n';
export function refFor(snapshot, sceneId, value) {
  const text = snapshot.scenes.find(s => s.id === sceneId).text;
  const index = text.indexOf(value);
  if (index < 0) throw Error('missing fixture anchor');
  return { snapshotId: snapshot.id, sceneId, startCp: [...text.slice(0, index)].length,
    endCp: [...text.slice(0, index + value.length)].length };
}
export const issue = (key = 'missing-transition') => ({ key, severity: 'major', detail: '行動への移行が唐突。' });
export function scriptSuggestion(snapshot) {
  return { id: 'add-hesitation', issueKey: 'missing-transition', kind: 'script_change',
    reason: '声をかける前の選択を伝える。', effect: '近づく行動に意味を持たせる。', benefit: 0.8,
    impact: { pageIds: ['page-1'], panelIds: ['panel-1'], deltaPages: 0, deltaPanels: 1 },
    edits: [{ op: 'insert_before', ref: refFor(snapshot, 'scene-1', 'アキが声をかける。'),
      expectedText: 'アキが声をかける。', text: INSERTION }] };
}
export function directionSuggestion(snapshot) {
  return { id: 'pause', issueKey: 'missing-transition', kind: 'direction_only',
    reason: '既に書かれた行動に読者の注目を置く。', effect: '静かな間を作る。', benefit: 0.8,
    impact: { pageIds: ['page-1'], panelIds: ['panel-1'], deltaPages: 0, deltaPanels: 0 },
    sourceRefs: [refFor(snapshot, 'scene-1', 'アキが声をかける。')], instruction: '既存の声をかける瞬間を大きく見せる。' };
}
export function fixtureAdapter(overrides = {}) {
  return {
    protocol: 'manga-director-adapter/v1', contract: 'name-plan/v2', mode: 'fixture',
    name: 'deterministic-test-double', version: 'fixture-1',
    async plan({ snapshot, directionInstructions }) {
      return { TEST_ONLY_NOT_A_NAME_PLAN: true, snapshotId: snapshot.id,
        sourceHash: digest(snapshot), directions: directionInstructions };
    },
    async validatePlan({ plan, snapshot }) {
      return { ok: plan.TEST_ONLY_NOT_A_NAME_PLAN === true && plan.snapshotId === snapshot.id && plan.sourceHash === digest(snapshot),
        contract: 'name-plan/v2', validatorVersion: 'TEST-DOUBLE-NOT-253', pageIds: ['page-1'], panelIds: ['panel-1'] };
    },
    async review({ snapshot }) {
      return snapshot.scenes[0].text.includes(INSERTION)
        ? { issues: [], suggestions: [] }
        : { issues: [issue()], suggestions: [scriptSuggestion(snapshot)] };
    },
    ...overrides,
  };
}
export default fixtureAdapter();
