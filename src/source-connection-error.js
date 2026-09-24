// Keep source connection diagnostics independent of the manuscript and credentials.
// Native GitHub errors have fixed prefixes; do not copy arbitrary exception bodies.
const status = message => Number(/\bGitHub\s+(401|403|404|408|413|422|429|5\d\d)\b/i.exec(message)?.[1] ?? 0);

export function sourceConnectionError(error, context = {}) {
  const message = String(error?.message ?? error ?? '');
  const code = status(message);
  const operation = context.operation ?? '原稿の取得';
  const unsupported = /Unsupported GitHub operation|この操作はMacアプリで利用できます|not available in browser/i.test(message);
  const originMismatch = message === 'ローカル原稿のoriginが選択したGitHubリポジトリと一致しません';
  const auth = code === 401 || (code === 403 && !/rate.limit|取得上限/i.test(message)) || (!code && /認証|権限|permission denied|authentication failed/i.test(message));
  const limit = code === 429 || code === 413 || /rate.limit|取得上限|too large|exceed.*limit|size limit/i.test(message);
  const missing = code === 404 || /not found|見つかりません|存在しません|選択した作品は.*対象ではありません|取り込む話を選び直してください/i.test(message);
  const network = code === 408 || code >= 500 || /failed to fetch|network|timeout|timed out|タイムアウト|接続でき|origin\/(dev|main) を取得できません/i.test(message);
  const kind = unsupported ? 'unsupported' : originMismatch ? 'origin' : limit ? 'limit' : auth ? 'auth' : missing ? 'missing' : network ? 'network' : 'unknown';
  const guidance = {
    unsupported: ['この環境では原稿を取得できません。', 'Macアプリの対応版で開いてください。', 'desktop'],
    origin: ['ローカル原稿の接続先が一致しません。', 'local-source.jsonのパスと、そのGitリポジトリのoriginを確認してください。', 'settings'],
    auth: ['原稿へのアクセス権を確認できません。', '読取り用トークンまたはGitの認証を設定し、同じ操作を再試行してください。', 'settings'],
    missing: ['指定したリポジトリ、作品または話が見つかりません。', '原稿ブランチと作品・話を確認してから再試行してください。', 'selection'],
    network: ['原稿への接続に失敗しました。', '通信状態を確認し、同じ操作を再試行してください。', 'retry'],
    limit: ['原稿の取得上限に達しました。', '時間をおいて再試行するか、取得する原稿の容量を確認してください。', 'retry'],
    unknown: ['原稿を取得できませんでした。', '詳細を確認し、同じ操作を再試行してください。', 'retry'],
  };
  const [summary, next, action] = guidance[kind];
  // Preserve the native status and known error text, but never copy unchecked
  // paths, JSON, response bodies, token-bearing URLs, or manuscript excerpts.
  let technical = '詳細不明（元のエラーに原稿・認証情報が含まれる可能性があります）';
  if (originMismatch) technical = 'Local Git origin mismatch';
  else if (/Unsupported GitHub operation/.test(message)) technical = 'Unsupported GitHub operation';
  else if (code) technical = `GitHub HTTP ${code}`;
  else if (/この操作はMacアプリで利用できます/.test(message)) technical = 'Mac-only operation in browser';
  else if (/origin\/(dev|main) を取得できません/.test(message)) technical = `origin/${/origin\/(dev|main)/.exec(message)[1]} fetch failed`;
  else if (/Invalid (repository|immutable source path)/.test(message)) technical = /Invalid repository/.test(message) ? 'Invalid repository' : 'Invalid immutable source path';
  else if (/failed to fetch/i.test(message)) technical = 'Failed to fetch';
  else if (/タイムアウト/.test(message)) technical = 'Source fetch timed out';
  const details = {
    schema: 'manga-mac/source-connection-diagnostic/v1', operation, kind, technical,
    build: context.build || '未記録', branch: context.branch || '未選択',
    // Avoid repo names, episode IDs, paths and free-form error strings in a
    // report that the user may paste into a public issue.
  };
  return {kind, summary, next, action, details, diagnostic: JSON.stringify(details, null, 2)};
}
