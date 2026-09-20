import { call } from './bridge.js';
import { imageModel, videoConnection } from './media.js';

// The UI reaches native media adapters through these two narrow gates. The
// registry selection is copied into every request so a saved job cannot drift
// to the currently selected model while it is being recovered or submitted.
export async function executeImage(modelId, request, permit = null) {
  const selected = imageModel(modelId ?? request.media?.registry_id);
  if (request.media?.model_id && request.media.model_id !== selected.model_id) {
    throw Error('画像要求と選択中のモデルが一致しません');
  }
  return call('generate_image', {
    request: {
      ...request,
      media: {
        registry_id: selected.id,
        adapter_id: selected.adapter_id,
        model_id: selected.model_id,
      },
    },
  }, permit);
}

export async function executeVideo(action, modelId, connectionId, args = {}) {
  const connection = videoConnection(modelId, connectionId);
  if (action === 'submit') return call('video_submit', { ...args, connectionId: connection.id });
  if (action === 'task') return call('video_task', { ...args, connectionId: connection.id });
  throw Error('動画adapter操作が不正です');
}
