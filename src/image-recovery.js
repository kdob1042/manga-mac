import { finishJob, imageHash } from './revisions.js';

// The same validation and masked compositing runs for live and recovered results.
export async function completeImage(context, image) {
  if (context?.version !== 1 || !context.panel || context.panel.image !== null) throw Error('画像の復旧情報がありません');
  const { imageOf, mergeRegion } = await import('./render');
  const actual = await imageOf(image), { width, height } = context.panel.generation ?? {};
  if (actual.width !== width || actual.height !== height) throw Error('画像エンジンの出力寸法が要求と一致しません');
  if (context.kind === 'edit') {
    if (!context.original || await imageHash(context.original) !== context.original_hash) throw Error('編集元画像の復旧情報が一致しません');
    image = await mergeRegion(context.original, image, context.rect);
  } else if (!['generate', 'retake'].includes(context.kind)) throw Error('未対応の復旧処理です');
  return { ...context.panel, image };
}

export async function recoverImageResult(project, jobId, receipt) {
  const job = project.jobs.find(item => item.id === jobId);
  if (!job) throw Error('制作要求がありません');
  if (job.output_revision && ['candidate', 'complete'].includes(job.status)) return project;
  if (job.status !== 'unknown' || receipt?.job_id !== job.id || receipt.input_hash !== job.input_hash || receipt.context?.kind !== job.kind || receipt.context?.panel?.id !== job.panelId || receipt.context?.panel?.snapshotId !== job.source_revision || receipt.hash !== await imageHash(receipt.image)) throw Error('保存結果と制作要求が一致しません');
  if(job.finishing && (!receipt.context.panel.finishing || Object.keys(job.finishing).length!==Object.keys(receipt.context.panel.finishing).length || Object.entries(job.finishing).some(([k,v])=>receipt.context.panel.finishing[k]!==v))) throw Error('仕上げ要求と保存結果が一致しません');
  const generated = await completeImage(receipt.context, receipt.image);
  // Recovery never adopts. The existing adoption check still compares the inputs.
  return finishJob({ ...project, jobs: project.jobs.map(item => item.id === jobId ? { ...item, status: 'running' } : item) }, job, generated, false, true);
}
