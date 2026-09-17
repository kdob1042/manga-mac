import React, { useState } from 'react';
import { askLLM } from './llm';
import {
  adoptContentReplan,
  contentBase,
  loadContentReplan,
  proposeContentReplan,
  resolveContentReplan,
} from './content-replan.js';

export default function ContentReplan({ project, current, commit, run, busy, model }) {
  const snapshot = project.snapshots.find((item) => item.id === project.active);
  const available = snapshot?.scenes?.filter((scene) => project.panels.some((panel) => panel.sceneId === scene.id && panel.snapshotId === project.active)) ?? [];
  const defaultIds = project.draftScope?.snapshotId === project.active
    ? project.draftScope.sceneIds.filter((id) => available.some((scene) => scene.id === id))
    : available.map((scene) => scene.id);
  const [selection, setSelection] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [candidate, setCandidate] = useState(null);
  if (!snapshot || !available.length) return null;
  const sceneIds = selection ?? defaultIds;
  const saved = project.jobs.filter((job) => job.kind === 'content_replan' && job.status === 'candidate' && job.content_candidate);

  function toggleScene(id, checked) {
    const next = checked ? [...sceneIds, id] : sceneIds.filter((sceneId) => sceneId !== id);
    setSelection(next);
  }

  async function propose() {
    if (!sceneIds.length) throw Error('再計画する場面を選んでください');
    if (!instruction.trim()) throw Error('内容再計画の指示を入力してください');
    if (!model.connectionId) throw Error('演出・コマ計画のAI接続を登録してください');
    const p = current.current;
    const inputHash = await contentBase(p);
    if (p.jobs.filter((job) => job.kind === 'content_replan' && job.input_hash === inputHash && ['running', 'candidate'].includes(job.status)).length >= 3) {
      throw Error('同じ基準版での内容再計画は3回までです。候補を確認するか、原稿を更新してください');
    }
    const id = crypto.randomUUID();
    await commit({ ...p, jobs: [...p.jobs, { id, kind: 'content_replan', status: 'running', source_revision: p.active, input_hash: inputHash, scope: { type: 'content', sceneIds: [...sceneIds] }, at: new Date().toISOString() }] });
    try {
      const next = await proposeContentReplan(
        current.current,
        sceneIds,
        instruction.trim(),
        (prompt, schema) => askLLM(model, { purpose: 'plan', prompt, schema }),
        id,
      );
      await commit({ ...current.current, jobs: current.current.jobs.map((job) => job.id === id ? { ...job, status: 'candidate', input_hash: next.base, content_candidate: next } : job) });
      setCandidate({ ...next, jobId: id });
    } catch (error) {
      await commit({ ...current.current, jobs: current.current.jobs.map((job) => job.id === id ? { ...job, status: 'failed' } : job) });
      throw error;
    }
  }

  async function openSaved(id) {
    setCandidate(await loadContentReplan(current.current, id));
  }

  async function adopt() {
    const next = await adoptContentReplan(current.current, candidate);
    await commit({ ...next, jobs: next.jobs.map((job) => job.id === candidate.jobId ? { ...job, status: 'complete' } : job) });
    setCandidate(null);
  }

  async function abandon() {
    if (candidate?.jobId) await commit(resolveContentReplan(current.current, candidate.jobId, 'abandoned'));
    setCandidate(null);
  }

  return <details className="content-replan">
    <summary>内容を再計画（コマの分割・統合）</summary>
    <p>原文unitのまとまりだけをAIに再提案します。ページ配置・既存画像・確定済みprefixは候補採用まで変更しません。</p>
    <fieldset disabled={busy}>
      <legend>対象場面</legend>
      {available.map((scene) => <label key={scene.id}><input type="checkbox" aria-label={`内容再計画対象 ${scene.id}`} checked={sceneIds.includes(scene.id)} onChange={(event) => toggleScene(scene.id, event.target.checked)}/>{scene.id}</label>)}
    </fieldset>
    <label>再計画の指示<textarea aria-label="内容再計画の指示" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="会話を一つのコマにまとめ、表情の変化は別コマにする"/></label>
    <button className="full" disabled={busy || !sceneIds.length || !model.connectionId} onClick={() => run('内容を再計画中', propose)}>内容再計画を提案</button>
    {!model.connectionId && <small>演出・コマ計画のAI接続が必要です。</small>}
    {saved.map((job) => <div key={job.id} className="saved-replan"><span>{job.content_candidate.reason}</span><button disabled={busy} onClick={() => run('保存済み候補を開く', () => openSaved(job.id))}>候補を表示</button><button disabled={busy} onClick={() => run('候補を取り下げ', () => commit(resolveContentReplan(current.current, job.id, 'abandoned')))}>取り下げ</button></div>)}
    {candidate && <div className="content-replan-candidate">
      <strong>{candidate.reason}</strong>
      {candidate.scenes.map((scene) => <div key={scene.sceneId}>
        <p>{scene.sceneId}：保持 {scene.retainedPanelIds.length}コマ / 再作画待ち {scene.redrawPanelIds.length}コマ / 確定済み {scene.protectedPanelIds.length}コマ</p>
        {!!scene.redrawPanelIds.length && <small>再作画対象: {scene.redrawPanelIds.join(', ')}</small>}
      </div>)}
      {candidate.summary?.changed && <small>採用後はP{candidate.summary.firstAffectedPageIndex + 1}以降のページ割当だけを決定的に詰め直します。既存画像・原稿・対象外場面は保持します。</small>}
      <button disabled={busy} onClick={() => run('内容再計画を採用中', adopt)}>この候補を採用</button>
      <button disabled={busy} onClick={() => run('内容再計画候補を取り下げ', abandon)}>候補を取り下げ</button>
    </div>}
  </details>;
}
