// Model adapters for the bounded host. API keys stay in the provider closure, never in prompts or logs.

const DEFAULT_XAI_BASE = 'https://api.x.ai/v1';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_XAI_MODEL = 'grok-4.7';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export function createOfflineProvider() {
  return {
    name: 'offline',
    async complete({ messages, signal }) {
      if (signal?.aborted) throw Object.assign(new Error('Model call cancelled'), { code: 'cancelled', name: 'AbortError' });
      const content = (messages || []).map(message => message.content || '').join('\n');
      const latest = /Latest item to answer:\n([\s\S]*?)\nWrite the next room message/.exec(content)?.[1] || '';
      const opening = /<([^>\n]+)>/.exec(latest)?.[1] || '';
      const inner = /<[^>\n]+>\n([\s\S]*?)\n<\//.exec(latest)?.[1]?.trim() || '';
      let text = 'NO_REPLY';
      if (inner && opening.includes('kind="feedback"')) text = `Revised: ${inner}`;
      else if (inner) text = `Reply to: ${inner}`;
      text = text.replace(/\s+/g, ' ').trim();
      const inputTokens = Math.max(1, Math.ceil(content.length / 4));
      const outputTokens = Math.max(1, Math.ceil(text.length / 4));
      return { text, usage: { inputTokens, outputTokens } };
    }
  };
}

export function resolveProviderConfig(env = process.env) {
  const mode = String(env.AGENT_LINK_PROVIDER || '').toLowerCase();
  if (mode === 'offline') return { mode: 'offline' };
  if (mode && mode !== 'xai' && mode !== 'openai') {
    throw Object.assign(new Error('AGENT_LINK_PROVIDER must be offline, xai, or openai'), { code: 'config' });
  }
  const useXai = mode === 'xai' || (mode !== 'openai' && !!env.XAI_API_KEY);
  const apiKey = useXai ? env.XAI_API_KEY : env.OPENAI_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw Object.assign(new Error('No model API key configured'), { code: 'config' });
  }
  const baseUrl = (env.OPENAI_BASE_URL || (useXai ? DEFAULT_XAI_BASE : DEFAULT_OPENAI_BASE)).replace(/\/$/, '');
  const model = env.AGENT_LINK_MODEL || (baseUrl.includes('api.x.ai') ? DEFAULT_XAI_MODEL : DEFAULT_OPENAI_MODEL);
  return { mode: 'openai-compatible', apiKey, baseUrl, model };
}

export function createOpenAICompatibleProvider({ apiKey, baseUrl, model, fetchImpl = fetch, timeoutMs = 90000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw Object.assign(new Error('Model API key is required'), { code: 'config' });
  let endpoint;
  try { endpoint = new URL(String(baseUrl).replace(/\/$/, '') + '/chat/completions'); }
  catch { throw Object.assign(new Error('Invalid model API base URL'), { code: 'config' }); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw Object.assign(new Error('Model API base URL must be HTTPS and must not embed credentials'), { code: 'config' });
  }
  if (typeof model !== 'string' || !model.trim()) throw Object.assign(new Error('Model name is required'), { code: 'config' });
  return {
    name: 'openai-compatible',
    baseUrl: endpoint.origin + endpoint.pathname.replace(/\/chat\/completions$/, ''),
    model,
    async complete({ system, messages, signal, maxOutputTokens = 500 }) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: maxOutputTokens,
            stream: false,
            messages: [
              { role: 'system', content: system },
              ...(messages || []).map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '') }))
            ]
          })
        });
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw Object.assign(new Error('Model call cancelled'), { code: 'cancelled', name: 'AbortError' });
        throw Object.assign(new Error('Model request failed'), { code: 'provider' });
      }
      let payload = {};
      try { payload = await response.json(); } catch { payload = {}; }
      if (!response.ok) throw Object.assign(new Error('Model request failed'), { code: 'provider', status: response.status });
      const content = payload?.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('') : '';
      if (!text.trim()) throw Object.assign(new Error('Model returned no text'), { code: 'provider' });
      const inputTokens = finite(payload?.usage?.prompt_tokens) || Math.ceil((system.length + text.length) / 4);
      const outputTokens = finite(payload?.usage?.completion_tokens) || Math.ceil(text.length / 4);
      return { text: text.trim(), usage: { inputTokens, outputTokens } };
    }
  };
}

export function createProviderFromEnv(env = process.env, fetchImpl = fetch) {
  const config = resolveProviderConfig(env);
  if (config.mode === 'offline') return createOfflineProvider();
  return createOpenAICompatibleProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, fetchImpl });
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
