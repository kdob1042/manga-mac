// Provider wire contracts moved to src-tauri/src/llm_tests.rs (real SDK fixtures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConnection, askLLM } from '../src/llm.js';
test('provider changes never carry an old key or registered connection', () => {
  for (const provider of ['ollama','openai','gemini','anthropic','deepseek','custom']) {
    const config = defaultConnection(provider);
    assert.equal(config.apiKey, ''); assert.equal(config.connectionId, ''); assert.equal(config.purpose, 'plan');
  }
  assert.equal(defaultConnection('ollama').purpose, 'plan');
});
test('normal requests require a registered connection before IPC', async () => {
  await assert.rejects(askLLM(defaultConnection(), { prompt: 'synthetic', schema: {} }), /登録/);
});
