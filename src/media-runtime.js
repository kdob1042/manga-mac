import { createImageExecutor } from './image-executor.js';
import { call } from './bridge.js';
import { imageModel, videoConnection } from './media.js';

// The UI reaches native media adapters through these two narrow gates. The
// registry selection is copied into every request so a saved job cannot drift
// to the currently selected model while it is being recovered or submitted.
export const executeImage = createImageExecutor(imageModel, call);

export async function executeVideo(action, modelId, connectionId, args = {}) {
  const connection = videoConnection(modelId, connectionId);
  if (action === 'submit') return call('video_submit', { ...args, connectionId: connection.id });
  if (action === 'task') return call('video_task', { ...args, connectionId: connection.id });
  throw Error('動画adapter操作が不正です');
}
