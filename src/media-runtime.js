import { createImageExecutor } from './image-executor.js';
import { call } from './bridge.js';
import { imageModel, videoConnection, videoModel } from './media.js';

// The UI reaches native media adapters through these two narrow gates. The
// registry selection is copied into every request so a saved job cannot drift
// to the currently selected model while it is being recovered or submitted.
export const executeImage = createImageExecutor(imageModel, call);

export async function executeVideo(action, modelId, connectionId, args = {}) {
  const connection = videoConnection(modelId, connectionId);
  const selected = videoModel(modelId);
  if (selected.adapter_id === 'ltx-mlx') {
    if (action !== 'submit') throw Error('ローカル動画は保存済みの結果を再読込してください。状態照会・再送は行いません');
    return call('local_video_submit', { ...args, connectionId: connection.id });
  }
  if (selected.adapter_id !== 'runway') throw Error('動画adapterが未対応です');
  if (action === 'submit') return call('video_submit', { ...args, connectionId: connection.id });
  if (action === 'task') return call('video_task', { ...args, connectionId: connection.id });
  throw Error('動画adapter操作が不正です');
}
