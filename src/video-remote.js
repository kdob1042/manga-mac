import { collectVideoResult } from './video.js';
import { videoModelForConnection } from './media.js';

// Reconcile transport metadata persisted by Rust into the existing domain jobs.
// This is called after IPC AND on restart; it never starts a network request.
export function restoreVideoResults(project) {
  let next = project;
  for (const original of project.jobs) {
    if (original.scope?.type !== 'videoShot' || !original.remote) continue;
    const remote = original.remote;
    if (remote.artifact && !original.output_revision) {
      next = collectVideoResult({ ...next, jobs: next.jobs.map(j => j.id === original.id ? { ...j, status: 'output_pending' } : j) }, original.id, remote.artifact);
      continue;
    }
    if (['candidate', 'complete', 'abandoned'].includes(original.status)) continue;
    const status = ({ PENDING: 'submitted', THROTTLED: 'submitted', RUNNING: 'submitted', SUCCEEDED: 'output_pending', FAILED: 'failed', CANCELLED: 'cancelled', cancel_requested: 'cancel_requested', unknown: 'unknown' })[remote.status];
    if (!status) throw Error('未対応の動画サービス状態です');
    const model = videoModelForConnection(original.manifest?.connection);
    const cost = model?.locality === 'local'
      ? { kind: 'local', amount: null, currency: null }
      : { kind: 'external', amount: remote.actual_credits ?? null, currency: 'credits', reserved: remote.reserved_credits };
    // An unchanged receipt must not rewrite a project containing large images.
    const sameCost = original.cost && Object.keys(original.cost).length === Object.keys(cost).length
      && Object.keys(cost).every(key => Object.hasOwn(original.cost, key) && original.cost[key] === cost[key]);
    if (original.status === status && sameCost) continue;
    next = { ...next, jobs: next.jobs.map(j => j.id === original.id ? { ...j, status, cost } : j) };
  }
  return next;
}

export const videoStatusLabel = job => ({ running: '送信準備中', unknown: '受理の成否が未確定', submitted: 'サービスで処理中', output_pending: '生成成功・動画取得待ち', cancel_requested: '取消の成否を確認中', cancelled: 'サービスの取消・削除応答を受領', failed: '生成失敗', candidate: '候補を保存済み', complete: '採用履歴あり', abandoned: '採用せず解決済み' })[job.status] ?? '状態を確認してください';

// Explicit local resolution only. This neither cancels a remote task nor refunds cost.
export function resolveVideoTask(project, jobId, serviceChecked) {
  const job = project.jobs.find(j => j.id === jobId);
  if (serviceChecked !== true || job?.scope?.type !== 'videoShot' || !['unknown', 'submitted', 'output_pending', 'cancel_requested'].includes(job.status) || job.output_revision || job.remote?.artifact) throw Error('サービス側を確認した未確定・未取得の動画要求だけを解決できます');
  return { ...project, jobs: project.jobs.map(j => j.id === jobId ? { ...j, status: 'abandoned', resolution: { kind: 'service_checked_not_adopted', at: new Date().toISOString() } } : j) };
}
