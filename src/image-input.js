// The local adapter uses explicit image input; capture metadata alone is not an image.
import { defaultImageModelId, imageModel, validateImageDimensions, validateImageReferences } from './media.js';

export function generationSize(resolution = [768, 768], modelId = defaultImageModelId) {
  const [width, height] = resolution;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096 || width / height > 4 || height / width > 4) throw Error('画像の縦横比・寸法が未対応です');
  const selected = imageModel(modelId), input = selected.input;
  const scale = Math.min(1, input.max_width / width, input.max_height / height);
  const next = [Math.max(input.min_width, Math.round(width * scale / input.step) * input.step), Math.max(input.min_height, Math.round(height * scale / input.step) * input.step)];
  validateImageDimensions(modelId, ...next);
  return next;
}
export function containRect(sourceWidth, sourceHeight, width, height) {
  if ([sourceWidth, sourceHeight, width, height].some(n => !Number.isFinite(n) || n <= 0)) throw Error('画像寸法が不正です');
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale, h = sourceHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h, scale };
}
export function imageRequest({ panel, references, original, originalHash, width, height, seed, instruction, job, capture, modelId = defaultImageModelId }) {
  if (original && !/^[0-9a-f]{64}$/.test(originalHash ?? '')) throw Error('元画像のハッシュが必要です');
  const selected = validateImageDimensions(modelId, width, height);
  validateImageReferences(modelId, references);
  return { ...(job?.cloud_connection?{cloud_connection:job.cloud_connection}:{}), job: job ? { id: job.id, input_hash: job.input_hash, base_revision: job.base_revision, source_revision: job.source_revision, scope: job.scope } : null,
    prompt: `${panel.prompt}\n${instruction}\nBlack and white manga illustration. No text, no lettering, no balloons. Preserve identities from the numbered reference images: ${references.map((r, i) => `${i + 1}: ${r.name}`).join(', ')}`,
    references, original, original_hash: originalHash ?? null, width, height, seed, steps: selected.input.steps,
    media: { registry_id: selected.id, adapter_id: selected.adapter_id, model_id: selected.model_id },
    capture: capture ? { id: capture.id, image_hash: capture.image.hash, checkpoint_hash: capture.checkpoint.hash } : null };
}
