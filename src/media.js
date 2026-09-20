import registry from './media-registry.json' with { type: 'json' };

// This is the only model list exposed to the UI. A descriptor means that the
// matching adapter is implemented; mentioning a future model here would make
// it look usable, so future adapters add their descriptor only when ready.
export const mediaRegistry = registry;
export const imageModels = registry.images;
export const videoModels = registry.videos;
export const defaultImageModelId = registry.defaults.image;
export const defaultVideoModelId = registry.defaults.video;

function model(list, id, label) {
  const result = list.find(item => item.id === id);
  if (!result || result.status !== 'implemented') throw Error(`${label}が未対応です`);
  return result;
}

export function imageModel(id = defaultImageModelId) {
  return model(imageModels, id, '画像モデル');
}

export function videoModel(id = defaultVideoModelId) {
  return model(videoModels, id, '動画モデル');
}

export function imageExecution(id = defaultImageModelId) {
  const selected = imageModel(id);
  return { registry_id: selected.id, adapter_id: selected.adapter_id, model_id: selected.model_id };
}

export function videoConnection(id = defaultVideoModelId, connectionId = '') {
  const selected = videoModel(id);
  if (typeof connectionId !== 'string' || !connectionId) throw Error('動画接続を登録してください');
  return { id: connectionId, provider: selected.provider, model: selected.model_id, adapter_id: selected.adapter_id };
}

export function videoModelForConnection(connection) {
  if (!connection || typeof connection !== 'object') return null;
  // Test-only injection. It is deliberately absent from videoModels and can
  // never be selected by the production UI.
  if (connection.provider === 'fixture' && connection.model === 'end-frame-v1') {
    return { id: 'fixture-end-frame-v1', display_name: 'fixture', adapter_id: 'fixture', provider: 'fixture', model_id: 'end-frame-v1', locality: 'local', status: 'test', capabilities: { end_frame: true, native_audio: false }, input: { duration_sec: 5, ratios: ['960:960'] } };
  }
  const selected = videoModels.find(item => item.provider === connection.provider && item.model_id === connection.model);
  if (!selected || selected.status !== 'implemented') return null;
  if (connection.adapter_id && connection.adapter_id !== selected.adapter_id) return null;
  return selected;
}

export function validateImageDimensions(id, width, height) {
  const selected = imageModel(id);
  const input = selected.input;
  if (![width, height].every(Number.isInteger)
    || width < input.min_width || width > input.max_width
    || height < input.min_height || height > input.max_height
    || width % input.step !== 0 || height % input.step !== 0
    || width / height > input.max_aspect_ratio || height / width > input.max_aspect_ratio) {
    throw Error('画像モデルが対応しない縦横・寸法です');
  }
  return selected;
}

export function imageOperationForJob(job) {
  if (job?.kind === 'edit') return 'edit';
  if (job?.kind === 'retake' && job?.finishing) return 'finishing';
  if (job?.kind === 'retake') return 'retake';
  return 'generate';
}

export function validateImageOperation(id, operation) {
  const selected = imageModel(id);
  if (!selected.operations.includes(operation)) throw Error(`画像モデルは${operation}に対応していません`);
  return selected;
}
