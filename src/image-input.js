// The local adapter uses explicit image input; capture metadata alone is not an image.
export function generationSize(resolution = [768, 768]) {
  const [width, height] = resolution;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096 || width / height > 4 || height / width > 4) throw Error('画像の縦横比・寸法が未対応です');
  const scale = Math.min(1, 1024 / Math.max(width, height));
  return [Math.max(256, Math.round(width * scale / 64) * 64), Math.max(256, Math.round(height * scale / 64) * 64)];
}
export function containRect(sourceWidth, sourceHeight, width, height) {
  if ([sourceWidth, sourceHeight, width, height].some(n => !Number.isFinite(n) || n <= 0)) throw Error('画像寸法が不正です');
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale, h = sourceHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h, scale };
}
export function imageRequest({ panel, references, original, originalHash, width, height, seed, instruction, job, capture }) {
  if (original && !/^[0-9a-f]{64}$/.test(originalHash ?? '')) throw Error('元画像のハッシュが必要です');
  return { job: job ? { id: job.id, base_revision: job.base_revision, source_revision: job.source_revision, scope: job.scope } : null,
    prompt: `${panel.prompt}\n${instruction}\nBlack and white manga illustration. No text, no lettering, no balloons. Preserve identities from the numbered reference images: ${references.map((r, i) => `${i + 1}: ${r.name}`).join(', ')}`,
    references, original, original_hash: originalHash ?? null, width, height, seed,
    capture: capture ? { id: capture.id, image_hash: capture.image.hash, checkpoint_hash: capture.checkpoint.hash } : null };
}
