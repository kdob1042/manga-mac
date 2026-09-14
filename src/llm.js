// Providers share one validated JSON contract. No automatic provider fallback.
export const providers = {
  ollama: { label: 'Ollama（ローカル）', baseUrl: 'http://127.0.0.1:11434' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  anthropic: { label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  custom: { label: 'OpenAI互換API', baseUrl: '' },
};
export function defaultConnection(provider = 'ollama', vision = false) {
  return { provider, baseUrl: providers[provider].baseUrl, model: provider === 'ollama' ? (vision ? 'qwen3-vl:4b' : 'qwen3:8b') : '', apiKey: '', jsonMode: true };
}
export function imageParts(image) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image);
  if (!m) throw Error('対応していない画像形式です');
  return { mime: m[1], data: m[2] };
}
export function buildLLMBody(config, { prompt, schema, images = [] }) {
  if (!providers[config.provider]) throw Error('接続先を選択してください');
  if (!config.model.trim()) throw Error('モデルIDを入力してください');
  if (config.provider !== 'ollama' && !config.apiKey.trim()) throw Error('APIキーを入力してください');
  const text = `${prompt}\n\nReturn only a JSON object matching this JSON schema. No markdown or commentary.\n${JSON.stringify(schema)}`;
  if (config.provider === 'ollama') return { model: config.model, stream: false, keep_alive: 0, format: schema, messages: [{ role: 'user', content: text, images: images.map(i => imageParts(i).data) }] };
  if (config.provider === 'anthropic') return { model: config.model, max_tokens: 8192, messages: [{ role: 'user', content: [...images.map(i => { const p = imageParts(i); return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }; }), { type: 'text', text }] }] };
  images.forEach(imageParts);
  return { model: config.model, stream: false, messages: [{ role: 'user', content: images.length ? [{ type: 'text', text }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] : text }], ...(config.jsonMode ? { response_format: { type: 'json_object' } } : {}) };
}
export function parseLLMResponse(provider, response) {
  let text;
  if (provider === 'ollama') { if (response.done_reason === 'length') throw Error('LLMの応答が長さ制限で中断されました'); text = response.message?.content; }
  else if (provider === 'anthropic') { if (response.stop_reason !== 'end_turn') throw Error('Claudeの応答が完了しませんでした'); text = response.content?.filter(c => c.type === 'text').map(c => c.text).join(''); }
  else { const choice = response.choices?.[0]; if (choice?.finish_reason !== 'stop') throw Error('LLMの応答が完了しませんでした。モデルと出力上限を確認してください'); text = choice.message?.content; }
  if (typeof text !== 'string' || !text.trim()) throw Error('LLMからJSON応答を取得できませんでした');
  text = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('JSONオブジェクトが必要です');
  return JSON.stringify(value);
}
export async function askLLM(config, request) {
  const body = buildLLMBody(config, request);
  const { call } = await import('./bridge.js');
  const response = await call('llm_request', { provider: config.provider, baseUrl: config.baseUrl, apiKey: config.apiKey, body });
  return parseLLMResponse(config.provider, JSON.parse(response));
}
