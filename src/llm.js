// Providers share one validated JSON contract. No automatic provider fallback.
import {withResource} from './execution.js';
export const providers = {
  ollama: { label: 'Ollama（ローカル）', baseUrl: 'http://127.0.0.1:11434' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  anthropic: { label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  custom: { label: 'OpenAI互換API', baseUrl: '' },
};
export function defaultConnection(provider = 'ollama') {
  return { provider, purpose: 'plan', baseUrl: providers[provider].baseUrl, model: provider === 'ollama' ? 'qwen3:8b' : '', apiKey: '', connectionId: '', jsonMode: true, concurrency:provider==='ollama'?1:2 };
}
export async function registerConnection(config) {
  const { call } = await import('./bridge.js');
  const connectionId = await call('register_llm', { input: { provider: config.provider, purpose: config.purpose, endpoint: config.baseUrl, model: config.model, credential: config.apiKey, json_mode: config.jsonMode } });
  return { ...config, apiKey: '', connectionId };
}
export async function releaseConnection(connectionId) {
  if (!connectionId) return;
  const { call } = await import('./bridge.js');
  await call('remove_llm', { connectionId });
}
const activeRequests = new Set();
export async function cancelLLMRequests() {
  const { call } = await import('./bridge.js');
  await Promise.all([...activeRequests].map(requestId => call('cancel_llm', { requestId })));
}
export async function askLLM(config, { prompt, schema, images = [], purpose = config.purpose, cancelled=()=>false, waiting=()=>{},started=()=>{} }) {
 return withResource(config.provider==='ollama'?'local-inference':`llm:${config.connectionId}`,config.provider==='ollama'?1:Math.min(2,config.concurrency??2),()=>{started();return requestLLM(config,{prompt,schema,images,purpose});},{cancelled,waiting});
}
async function requestLLM(config,{prompt,schema,images,purpose}){
  if (!config.connectionId) throw Error('AIの接続を登録・テストしてください');
  const { call } = await import('./bridge.js');
  const requestId = crypto.randomUUID();
  activeRequests.add(requestId);
  try {
  const response = await call('llm_request', { request: { connection_id: config.connectionId, purpose, request_id: requestId, prompt, schema, images } });
  if (response.request_id !== requestId || !response.value || typeof response.value !== 'object' || Array.isArray(response.value)) throw Error('LLMの応答が要求と一致しません');
  return JSON.stringify(response.value);
  } finally { activeRequests.delete(requestId); }
}
