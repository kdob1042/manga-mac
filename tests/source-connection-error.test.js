import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceConnectionError} from '../src/source-connection-error.js';

test('native unsupported operation and authentication failure have distinct recovery actions',()=>{
  const context={operation:'原稿カタログの取得',branch:'dev',build:'a'.repeat(40)};
  const unsupported=sourceConnectionError(Error('Unsupported GitHub operation'),context);
  const auth=sourceConnectionError(Error('GitHub 401 — 接続権限・レート制限を確認してください'),context);
  assert.equal(unsupported.action,'desktop');
  assert.equal(auth.action,'settings');
  assert.match(auth.diagnostic,/GitHub HTTP 401/);
  assert.equal(JSON.parse(auth.diagnostic).build,context.build);
  assert.equal(JSON.parse(unsupported.diagnostic).operation,context.operation);
});

test('redacts all untrusted error details while retaining known native codes and operation',()=>{
  const secret='github_pat_1234567890secret', manuscript='未公開の原稿本文';
  const report=sourceConnectionError(Error(`GitHub 404 https://user:${secret}@github.com/o/r?token=${secret} ${manuscript}`),{operation:'作品・話の取得'});
  assert.equal(report.kind,'missing');
  assert.equal(report.action,'selection');
  assert.equal(JSON.parse(report.diagnostic).technical,'GitHub HTTP 404');
  assert.ok(!report.diagnostic.includes(secret));
  assert.ok(!report.diagnostic.includes(manuscript));
  assert.ok(!report.diagnostic.includes('https://'));
  assert.equal(sourceConnectionError(Error('GitHub 429')).kind,'limit');
  assert.equal(sourceConnectionError(Error('origin/dev を取得できません。接続またはGitの認証を確認してください')).kind,'auth');
  const wrongOrigin=sourceConnectionError(Error('ローカル原稿のoriginが選択したGitHubリポジトリと一致しません'));
  assert.equal(wrongOrigin.kind,'origin');assert.equal(wrongOrigin.action,'settings');
  assert.equal(JSON.parse(wrongOrigin.diagnostic).technical,'Local Git origin mismatch');
});
