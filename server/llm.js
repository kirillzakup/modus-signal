'use strict';
/**
 * Клиент LLM без зависимостей (global fetch).
 *   LLM_PROVIDER  anthropic | openai (OpenAI-совместимые: OpenAI, OpenRouter, vLLM, Ollama, шлюзы YandexGPT и т. п.)
 *   LLM_API_KEY   ключ (запасные варианты: ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *   LLM_MODEL     модель (по умолчанию claude-sonnet-5-5 / gpt-4o-mini)
 *   LLM_BASE_URL  базовый адрес (по умолчанию https://api.anthropic.com / https://api.openai.com/v1)
 *   LLM_MAX_TOKENS по умолчанию 1500
 * Ключ никогда не пишется в логи и не возвращается клиенту.
 */

const DEFAULTS = {
  anthropic: { model: 'claude-sonnet-5-5', base: 'https://api.anthropic.com' },
  openai: { model: 'gpt-4o-mini', base: 'https://api.openai.com/v1' }
};
const TIMEOUT_MS = 90 * 1000;

function readLlmConfig(env = process.env) {
  let provider = String(env.LLM_PROVIDER || '').toLowerCase().trim();
  if (provider && !DEFAULTS[provider]) provider = '';
  if (!provider) {
    if (env.LLM_API_KEY || env.ANTHROPIC_API_KEY) provider = 'anthropic';
    else if (env.OPENAI_API_KEY) provider = 'openai';
  }
  if (!provider) return { configured: false, provider: null, model: null };
  const key = env.LLM_API_KEY || (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) || '';
  const baseUrl = (env.LLM_BASE_URL || DEFAULTS[provider].base).replace(/\/+$/, '');
  // Локальной OpenAI-совместимой модели (Ollama, vLLM) ключ может быть не нужен
  const configured = !!key || (provider === 'openai' && !!env.LLM_BASE_URL);
  return {
    configured, provider, key, baseUrl,
    model: env.LLM_MODEL || DEFAULTS[provider].model,
    maxTokens: Number(env.LLM_MAX_TOKENS) || 1500,
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || TIMEOUT_MS
  };
}

/** Нормализовать историю: только user/assistant, первый — user, без повторов ролей подряд. */
function normalizeMessages(history, prompt) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-6)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));
  turns.push({ role: 'user', content: prompt });
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += '\n\n' + t.content;
    else out.push({ role: t.role, content: t.content });
  }
  return out;
}

function createLLM(cfg = readLlmConfig(), { fetchImpl = globalThis.fetch } = {}) {
  const info = { configured: !!cfg.configured, provider: cfg.provider || null, model: cfg.model || null };
  if (!cfg.configured) {
    return { info, configured: false, async complete() { throw new Error('ИИ не подключён'); } };
  }

  async function post(url, headers, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body), signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j.error && (j.error.message || j.error.type || j.error)) || ('HTTP ' + r.status);
        throw new Error('LLM ' + r.status + ': ' + String(msg).slice(0, 300));
      }
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('LLM: превышено время ожидания ответа');
      throw e;
    } finally { clearTimeout(timer); }
  }

  /** Отправить промпт (и до 6 реплик истории). Возвращает { text, model }. */
  async function complete(prompt, { history } = {}) {
    const messages = normalizeMessages(history, prompt);
    if (cfg.provider === 'anthropic') {
      const url = /\/v1$/.test(cfg.baseUrl) ? cfg.baseUrl + '/messages' : cfg.baseUrl + '/v1/messages';
      const j = await post(url, { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' }, { model: cfg.model, max_tokens: cfg.maxTokens, messages });
      const text = (j.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('').trim();
      if (!text) throw new Error('LLM вернул пустой ответ');
      return { text, model: j.model || cfg.model };
    }
    const headers = cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {};
    const j = await post(cfg.baseUrl + '/chat/completions', headers, { model: cfg.model, max_tokens: cfg.maxTokens, messages });
    const text = String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
    if (!text) throw new Error('LLM вернул пустой ответ');
    return { text, model: j.model || cfg.model };
  }

  return { info, configured: true, complete };
}

module.exports = { createLLM, readLlmConfig, normalizeMessages };
