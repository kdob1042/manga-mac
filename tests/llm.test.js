import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConnection, buildLLMBody, parseLLMResponse } from '../src/llm.js';
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const request = { prompt: 'original manuscript', schema, images: ['data:image/jpeg;base64,YWJj'] };
const config = p => ({ ...defaultConnection(p), model: 'test-model', apiKey: 'secret-test-key' });
test('local request has native schema, unloads model and strips image URI', () => {
 const body = buildLLMBody(defaultConnection(), request);
 assert.equal(body.keep_alive, 0); assert.deepEqual(body.format, schema); assert.deepEqual(body.messages[0].images, ['YWJj']);
});
test('compatible providers preserve image MIME and never embed key in body', () => {
 for (const p of ['openai','gemini','deepseek','custom']) { const body = buildLLMBody(config(p), request); assert.equal(body.messages[0].content[1].image_url.url, request.images[0]); assert.equal(body.response_format.type, 'json_object'); assert.ok(!JSON.stringify(body).includes('secret-test-key')); }
});
test('Claude uses image blocks with original MIME and token budget', () => {
 const body = buildLLMBody(config('anthropic'), request); assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg'); assert.equal(body.messages[0].content[0].source.data, 'YWJj'); assert.equal(body.max_tokens, 8192);
});
test('custom API can use prompt JSON without unsupported response_format', () => { assert.equal(buildLLMBody({ ...config('custom'), jsonMode: false }, request).response_format, undefined); });
test('missing key/model fails before network; unsupported images rejected', () => {
 assert.throws(() => buildLLMBody(defaultConnection('openai'), request));
 assert.throws(() => buildLLMBody({ ...config('gemini'), apiKey: '' }, request));
 assert.throws(() => buildLLMBody(config('openai'), { ...request, images: ['https://unrelated/image'] }));
});
test('normalizes JSON contracts across providers and rejects partial or refused output', () => {
 assert.equal(parseLLMResponse('ollama', { message: { content: '{"ok":true}' } }), '{"ok":true}');
 assert.equal(parseLLMResponse('anthropic', { stop_reason:'end_turn',content:[{ type:'text',text:'```json\n{"ok":true}\n```' }] }), '{"ok":true}');
 assert.equal(parseLLMResponse('openai', { choices:[{ finish_reason:'stop', message:{ content:'{"ok":true}' } }] }), '{"ok":true}');
 for (const finish_reason of ['length','content_filter','tool_calls']) assert.throws(() => parseLLMResponse('openai', { choices:[{ finish_reason, message:{ content:'{"ok":true}' } }] }));
 assert.throws(() => parseLLMResponse('anthropic', { stop_reason:'max_tokens',content:[{type:'text',text:'{}'}] }));
 assert.throws(() => parseLLMResponse('openai', { choices:[{finish_reason:'stop',message:{content:'not json'}}] }));
});
test('switching provider starts with no previous key', () => { assert.equal(defaultConnection('gemini').apiKey, ''); });
