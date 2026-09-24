import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectTapNow, MCP_URL } from '../scripts/tapnow-mcp-probe.mjs';

const resource = { resource: MCP_URL, authorization_servers: ['https://oauth.tapnow.ai'], scopes_supported: ['mcp.tools.read', 'mcp.tools.invoke'] };
const auth = { issuer: 'https://oauth.tapnow.ai', registration_endpoint: 'https://oauth.tapnow.ai/oauth/register', authorization_endpoint: 'https://oauth.tapnow.ai/authorize', token_endpoint: 'https://oauth.tapnow.ai/token', code_challenge_methods_supported: ['S256'] };

test('TapNow probe only lists tools and never invokes paid tools', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url === MCP_URL
      ? { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'sample', inputSchema: { type: 'object' } }] } }
      : url.includes('protected-resource') ? resource : auth };
  };
  const report = await inspectTapNow({ fetcher, token: 'private-token' });
  assert.equal(report.tools[0].name, 'sample');
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[2].options.body).method, 'tools/list');
  assert.doesNotMatch(JSON.stringify(report), /private-token/);
});

test('changed OAuth issuer is rejected before any authenticated request', async () => {
  let calls = 0;
  const fetcher = async url => {
    calls += 1;
    return { ok: true, json: async () => url.includes('protected-resource') ? resource : { ...auth, issuer: 'https://example.invalid' } };
  };
  await assert.rejects(inspectTapNow({ fetcher, token: 'private-token' }), /OAuth 公開設定/);
  assert.equal(calls, 2);
});

test('TapNow MCP SSE response can be listed without calling a generation tool', async () => {
  const fetcher = async url => url === MCP_URL
    ? {
      ok: true,
      headers: { get: () => 'text/event-stream' },
      text: async () => 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"list_assets","inputSchema":{"type":"object"}}]}}\n\n',
    }
    : { ok: true, json: async () => url.includes('protected-resource') ? resource : auth };
  const result = await inspectTapNow({ fetcher, token: 'private-token' });
  assert.deepEqual(result.tools.map(tool => tool.name), ['list_assets']);
});
