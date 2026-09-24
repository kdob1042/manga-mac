#!/usr/bin/env node
// Read-only contract probe. Never calls tools/call or starts a paid generation.
import { pathToFileURL } from 'node:url';

export const MCP_URL = 'https://mcp.tapnow.ai/api/agent-gateway/mcp/general/mcp';
const RESOURCE_METADATA_URL = 'https://mcp.tapnow.ai/.well-known/oauth-protected-resource/api/agent-gateway/mcp/general/mcp';
const AUTHORIZATION_METADATA_URL = 'https://oauth.tapnow.ai/.well-known/oauth-authorization-server';

export function assertMetadata(resource, authorization) {
  if (resource?.resource !== MCP_URL
    || !resource.authorization_servers?.includes('https://oauth.tapnow.ai')
    || authorization?.issuer !== 'https://oauth.tapnow.ai'
    || authorization.registration_endpoint !== 'https://oauth.tapnow.ai/oauth/register'
    || !authorization.code_challenge_methods_supported?.includes('S256')) {
    throw Error('TapNow の OAuth 公開設定が想定と異なります。接続仕様を再確認してください');
  }
  return {
    resource: resource.resource,
    issuer: authorization.issuer,
    scopes: resource.scopes_supported ?? [],
    registration_endpoint: authorization.registration_endpoint,
    authorization_endpoint: authorization.authorization_endpoint,
    token_endpoint: authorization.token_endpoint,
  };
}

async function readJSON(fetcher, url, options) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`TapNow の公開設定またはツール一覧を取得できません (HTTP ${response.status})`);
  if (response.headers?.get('content-type')?.includes('text/event-stream')) {
    const events = (await response.text()).split(/\r?\n\r?\n/);
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (data) return JSON.parse(data);
    }
    throw Error('TapNow の MCP 応答が空です');
  }
  return response.json();
}

export async function inspectTapNow({ fetcher = fetch, token } = {}) {
  const [resource, authorization] = await Promise.all([
    readJSON(fetcher, RESOURCE_METADATA_URL),
    readJSON(fetcher, AUTHORIZATION_METADATA_URL),
  ]);
  const report = { oauth: assertMetadata(resource, authorization), tools: null };
  if (!token) return report;

  // MCP's read-only listing. No paid tool invocation and no bearer token in the report.
  const response = await readJSON(fetcher, MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  if (response.error || !Array.isArray(response.result?.tools)) {
    throw Error('TapNow のツール一覧の形式を確認できません。MCP 初期化が必要な場合は接続方式を調整してください');
  }
  report.tools = response.result.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await inspectTapNow({ token: process.env.TAPNOW_MCP_BEARER });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.tools) {
      process.stderr.write('認可済みトークンなし: 公開 OAuth 設定のみ確認。生成ツール仕様は未確認です。\n');
    }
  } catch (error) {
    // Avoid printing HTTP bodies, URLs with query parameters, or tokens.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
