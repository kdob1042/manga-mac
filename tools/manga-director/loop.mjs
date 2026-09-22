import {
  DirectorError, check, copy, digest, freeze, ids, text, prepareInput,
  validateReview, proposalFingerprint, applyWorkingEdits, finalDiff,
} from './data.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  maxIterations: 3, maxModelCalls: 6, stageTimeoutMs: 120000,
  maxAddedCp: 2000, maxAddedPages: 2, minBenefit: 0.15, minImprovement: 1,
});

function configuration(override) {
  check(Object.keys(override).every(k => Object.hasOwn(DEFAULT_LIMITS, k)), 'UNKNOWN_LIMIT');
  const v = { ...DEFAULT_LIMITS, ...override };
  for (const [key, min, max] of [
    ['maxIterations', 1, 30], ['maxModelCalls', 1, 60], ['stageTimeoutMs', 1, 600000],
    ['maxAddedCp', 0, 100000], ['maxAddedPages', 0, 100], ['minImprovement', 1, 300],
  ]) check(Number.isSafeInteger(v[key]) && v[key] >= min && v[key] <= max, 'INVALID_LIMIT');
  check(Number.isFinite(v.minBenefit) && v.minBenefit >= 0 && v.minBenefit <= 1, 'INVALID_LIMIT');
  return freeze(v);
}

async function bounded(fn, argument, outerSignal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new DirectorError('ABORTED'));
  if (outerSignal?.aborted) onAbort(); else outerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DirectorError('STAGE_TIMEOUT')), timeoutMs);
  let rejectAbort;
  const abort = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => fn(argument, { signal: controller.signal })), abort]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', rejectAbort);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Execute outside Tauri. The trusted adapter owns the existing #253 validator and
 * #255 one-shot planner. No plan schema, LLM transport, GUI or database is cloned.
 * The review result is only a candidate judgment, never evidence of reader quality.
 */
export async function runDirector(rawInput, adapter, {
  limits: overrides = {}, signal, checkpoint = async () => {}, assertSourceUnchanged = async () => {},
} = {}) {
  const input = prepareInput(rawInput), original = input.snapshot, limits = configuration(overrides);
  check(adapter?.protocol === 'manga-director-adapter/v1' && adapter.contract === 'name-plan/v2', 'ADAPTER_CONTRACT');
  check(['live', 'fixture'].includes(adapter.mode), 'ADAPTER_MODE');
  text(adapter.name, 256); text(adapter.version, 256);
  for (const key of ['plan', 'review', 'validatePlan']) check(typeof adapter[key] === 'function', 'ADAPTER_METHOD_MISSING');
  const provenance = freeze({ name: adapter.name, version: adapter.version, mode: adapter.mode, contract: adapter.contract });
  const report = {
    format: 'manga-director-run/v1', runId: digest([input, limits, provenance]), adapter: provenance,
    originalHash: digest(original), originalSnapshotId: original.id,
    selectedSceneIds: input.selectedSceneIds, contextHash: digest(input.context),
    limits, modelCalls: 0, iterations: [], selectedIteration: null,
    stopReason: null, status: 'blocked', humanApproval: 'pending',
  };
  let current = original, best = null, direction = [], priorPlan = null, transition = null;
  let baselinePages = null, stage = 'input';
  const seen = new Set();
  const emit = async event => checkpoint(freeze(copy({ runId: report.runId, ...event })));
  const guard = async () => {
    check(!signal?.aborted, 'ABORTED');
    try { await assertSourceUnchanged(); } catch { throw new DirectorError('SOURCE_CHANGED'); }
  };
  const call = async (name, argument, iteration, isModel = true) => {
    stage = name;
    await guard();
    if (isModel) {
      check(report.modelCalls < limits.maxModelCalls, 'MODEL_CALL_LIMIT');
      report.modelCalls++;
    }
    // Persist the pending state BEFORE handing control to a provider; no auto-resume.
    await emit({ event: 'stage_started', iteration, stage: name, inputHash: digest(argument), modelCalls: report.modelCalls });
    const value = copy(await bounded(adapter[name].bind(adapter), freeze(copy(argument)), signal, limits.stageTimeoutMs));
    await guard();
    await emit({ event: 'stage_finished', iteration, stage: name, outputHash: digest(value) });
    return value;
  };
  const settleTransition = status => {
    if (transition) for (const d of transition.decisions) if (d.status === 'trial') d.status = status;
    transition = null;
  };
  const stop = reason => { report.stopReason = reason; };
  try {
    await guard();
    for (let iteration = 1; iteration <= limits.maxIterations; iteration++) {
      const row = { iteration, inputHash: digest(current), planHash: null, reviewHash: null, decisions: [] };
      report.iterations.push(row);
      const plan = freeze(await call('plan', {
        snapshot: current, originalSnapshotId: original.id, selectedSceneIds: input.selectedSceneIds,
        readOnlyContext: input.context, previousPlan: priorPlan, directionInstructions: direction,
        iteration, limits, previousIssues: best?.review.issues ?? [],
      }, iteration));
      row.planHash = digest(plan);
      const validation = await call('validatePlan', {
        plan, snapshot: current, selectedSceneIds: input.selectedSceneIds,
      }, iteration, false);
      check(validation.ok === true && validation.contract === 'name-plan/v2', 'INVALID_PLAN');
      text(validation.validatorVersion, 256);
      ids(validation.pageIds); ids(validation.panelIds);
      row.validatorVersion = validation.validatorVersion;
      row.pageCount = validation.pageIds.length;
      baselinePages ??= row.pageCount;
      check(row.pageCount <= baselinePages + limits.maxAddedPages, 'PAGE_GROWTH_LIMIT');
      const review = validateReview(await call('review', {
        snapshot: current, selectedSceneIds: input.selectedSceneIds, readOnlyContext: input.context,
        plan, pageIds: validation.pageIds, panelIds: validation.panelIds, iteration,
        previousIssues: best?.review.issues ?? [], limits,
      }, iteration), current, input.selectedSceneIds, validation);
      row.reviewHash = digest(review);
      row.review = review;
      row.majorIssues = review.issues.filter(i => i.severity === 'major').length;
      row.loss = review.issues.reduce((sum, i) => sum + (i.severity === 'major' ? 3 : 1), 0);
      row.decisions = review.suggestions.map(s => ({ id: s.id, kind: s.kind, status: 'not_applied' }));
      // A trial which did not help never displaces the last consistent script/plan.
      if (best && row.majorIssues > 0 && best.loss - row.loss < limits.minImprovement) {
        settleTransition('rolled_back'); stop('no_improvement'); break;
      }
      settleTransition('retained_in_working');
      best = { iteration, snapshot: current, plan, review, loss: row.loss };
      if (!row.majorIssues) { stop('no_major_issues'); break; }
      if (iteration === limits.maxIterations) { stop('iteration_limit'); break; }
      const eligible = [];
      for (const [i, suggestion] of review.suggestions.entries()) {
        const decision = row.decisions[i];
        if (suggestion.benefit < limits.minBenefit) { decision.status = 'insufficient_benefit'; continue; }
        const fingerprint = proposalFingerprint(suggestion, current);
        decision.fingerprint = fingerprint;
        if (seen.has(fingerprint)) { decision.status = 'repeated'; continue; }
        eligible.push(suggestion);
      }
      if (!eligible.length) {
        stop(row.decisions.some(d => d.status === 'repeated') ? 'repeated_proposal' : 'no_actionable_suggestions'); break;
      }
      // Predicted cost is only a filter; actual page and text growth are also checked.
      check(eligible.reduce((sum, s) => sum + Math.max(0, s.impact.deltaPages), 0) <= limits.maxAddedPages, 'PAGE_GROWTH_LIMIT');
      await guard();
      const trial = applyWorkingEdits(original, current, eligible, limits.maxAddedCp);
      direction = eligible.filter(s => s.kind === 'direction_only').map(s => ({
        instruction: s.instruction, effect: s.effect, impact: s.impact,
        // Keep the old reference with its own snapshot, never relabel shifted offsets.
        basisSnapshotId: current.id, sourceRefs: s.sourceRefs,
      }));
      for (const s of eligible) {
        const d = row.decisions.find(item => item.id === s.id);
        d.status = 'trial'; seen.add(d.fingerprint);
      }
      row.trialHash = digest(trial);
      transition = row;
      // Bind previous-plan and direction references to their original immutable input.
      priorPlan = { plan, snapshot: current };
      current = trial;
      await emit({ event: 'trial_prepared', iteration, snapshotHash: digest(current), decisions: row.decisions });
    }
    await guard();
  } catch (error) {
    settleTransition('rolled_back');
    // Provider messages may contain API keys or unpublished text. Persist only codes.
    stop(error instanceof DirectorError ? error.code : 'ADAPTER_OR_CHECKPOINT_FAILED');
    report.failedStage = stage;
  }
  if (transition) settleTransition('rolled_back');
  report.stopReason ??= 'iteration_limit';
  report.selectedIteration = best?.iteration ?? null;
  const normalStop = ['no_major_issues', 'no_improvement', 'repeated_proposal', 'no_actionable_suggestions', 'iteration_limit'].includes(report.stopReason);
  report.status = best && normalStop ? 'review_required' : 'blocked';
  const workingSnapshot = best?.snapshot ?? original;
  const result = {
    ...report, workingHash: digest(workingSnapshot), workingSnapshot,
    namePlan: best?.plan ?? null, finalDiff: finalDiff(original, workingSnapshot),
    handoff: {
      state: 'candidate_only', sourceApprovalRequired: digest(workingSnapshot) !== digest(original),
      requiresSharedValidation: true, requiresApprovedSourceRebinding: workingSnapshot.id !== original.id,
    },
  };
  await emit({ event: 'stopped', stopReason: result.stopReason, selectedIteration: result.selectedIteration, workingHash: result.workingHash });
  return freeze(result);
}
