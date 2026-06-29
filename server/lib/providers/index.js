// ── Provider dispatcher ───────────────────────────────────────────────────────
// Wraps the Vercel AI SDK so the rest of Hive can stream chat from any provider
// (Ollama, Anthropic, OpenAI, Gemini) through one interface, routed by the model
// id prefix. Both call sites (runAgentOnce, websocket) consume streamChat() and
// see the same normalized event shape they accumulated from Ollama NDJSON before.

const crypto = require('crypto');
const { streamText, jsonSchema } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { createOllama } = require('ai-sdk-ollama');
const db = require('../../db');
const { getOllamaUrl, ollamaApiUrl } = require('../ollamaUrl');
const { resolveSecret } = require('../secrets');
const {
  parseModel, splitSystem, toModelMessages, mapUsage,
  toOllamaMessages, toOllamaTools, ollamaStats,
} = require('./adapters');

// Shared AbortError factory — both stream paths and callers (websocket chat,
// colony cancellation, pipelines) key off this single error name.
function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

// app_settings key + env var fallback per cloud provider.
const KEY_SETTING = { anthropic: 'anthropic_api_key', openai: 'openai_api_key', gemini: 'gemini_api_key' };
const ENV_VAR     = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const LABEL        = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' };

function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch { return fallback; }
}

function ollamaBaseUrl() {
  return getOllamaUrl();
}

// Resolve a raw API key for a cloud provider: env first, then DB setting.
// DB settings may be literal values or references such as env:OPENAI_API_KEY.
function keyFor(provider) {
  const env = ENV_VAR[provider] ? process.env[ENV_VAR[provider]] : null;
  if (env && env.trim()) return env.trim();
  const settingKey = KEY_SETTING[provider];
  const v = settingKey ? getSetting(settingKey) : null;
  const resolved = resolveSecret(v).trim();
  if (resolved) return resolved;
  return null;
}

function hasKey(provider) {
  if (provider === 'ollama') return true;
  if (gatewayConfig().enabled) return true; // gateway holds the cloud keys
  return !!keyFor(provider);
}

// LLM gateway (LiteLLM proxy): when LLM_GATEWAY_URL / the llm_gateway_url setting
// is set, every CLOUD provider routes through one OpenAI-compatible endpoint that
// holds the real provider keys. Hive then only ever holds the revocable,
// localhost-scoped gateway key (or none). Ollama is local and unaffected.
function gatewayConfig() {
  const url = (process.env.LLM_GATEWAY_URL || getSetting('llm_gateway_url') || '').trim();
  if (!url) return { enabled: false, url: '', key: '' };
  const key = (process.env.LLM_GATEWAY_KEY || resolveSecret(getSetting('llm_gateway_key')) || '').trim();
  return { enabled: true, url, key: key || 'sk-hive-gateway' };
}

// Mint (once) and return a per-agent LiteLLM virtual key carrying the agent's
// max_budget, so the gateway enforces the cap and attributes spend to it. Returns
// null when the gateway is off, no budget is set, or minting fails (the caller
// then falls back to the shared gateway key). Persists the key on the agent row.
async function ensureAgentGatewayKey(agent) {
  const gw = gatewayConfig();
  if (!gw.enabled || !agent) return null;
  const budget = Number(agent.gateway_budget_usd) || 0;
  if (budget <= 0) return null;                       // no per-agent budget → shared key
  if (agent.gateway_key) return agent.gateway_key;    // already minted
  const adminBase = gw.url.replace(/\/v1\/?$/, '');   // /key/generate lives at the root
  try {
    const res = await fetch(`${adminBase}/key/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.key}` },
      body: JSON.stringify({
        max_budget: budget,
        metadata: { agent_id: agent.id, agent_name: agent.name || agent.id, source: 'hive-agent-budget' },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const key = data && data.key;
    if (key) {
      try { db.prepare('UPDATE agents SET gateway_key=? WHERE id=?').run(key, agent.id); } catch {}
      agent.gateway_key = key;
      return key;
    }
  } catch { /* gateway unreachable — fall back to the shared key */ }
  return null;
}

// Spend-attribution header for gateway calls. LiteLLM records the JSON in
// LiteLLM_SpendLogs.metadata, so cost can be grouped by agent/colony/session.
// No-op (undefined) when there's no metadata or no value.
function gatewayHeaders(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const clean = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v != null && v !== '') clean[k] = String(v);
  }
  return Object.keys(clean).length ? { 'x-litellm-spend-logs-metadata': JSON.stringify(clean) } : undefined;
}

// Build an AI SDK model instance for a parsed model.
function getModel(provider, modelId, settings = {}) {
  // metadata + a per-agent gateway key ride alongside model settings but are only
  // used for the gateway; strip them before passing the rest to the Ollama client.
  const { metadata, gatewayKey, ...modelSettings } = settings;
  // Capability alias ("gateway/hive-smart"): send the bare alias to the gateway
  // so its multi-provider failover pool (retries + fallbacks) applies.
  if (provider === 'gateway') {
    const gw = gatewayConfig();
    if (!gw.enabled) {
      throw new Error('A gateway model was selected but no LLM gateway is configured (Settings → Model Providers → LLM Gateway).');
    }
    return createOpenAI({ baseURL: gw.url, apiKey: gatewayKey || gw.key, headers: gatewayHeaders(metadata) }).chat(modelId);
  }
  if (provider !== 'ollama') {
    const gw = gatewayConfig();
    if (gw.enabled) {
      // LiteLLM exposes /v1/chat/completions; use .chat() so the SDK doesn't
      // default to the Responses API. The gateway's wildcard routing maps the
      // "<provider>/<model>" id to the correct upstream provider. A per-agent
      // virtual key (gatewayKey) overrides the shared key for budget enforcement.
      return createOpenAI({ baseURL: gw.url, apiKey: gatewayKey || gw.key, headers: gatewayHeaders(metadata) }).chat(`${provider}/${modelId}`);
    }
  }
  switch (provider) {
    case 'anthropic': {
      const apiKey = keyFor('anthropic');
      if (!apiKey) throw new Error(`${LABEL.anthropic} API key not set. Add it in Settings → Model Providers.`);
      return createAnthropic({ apiKey })(modelId);
    }
    case 'openai': {
      const apiKey = keyFor('openai');
      if (!apiKey) throw new Error(`${LABEL.openai} API key not set. Add it in Settings → Model Providers.`);
      // @ai-sdk/openai v3 defaults to the Responses API.
      return createOpenAI({ apiKey })(modelId);
    }
    case 'gemini': {
      const apiKey = keyFor('gemini');
      if (!apiKey) throw new Error(`${LABEL.gemini} API key not set. Add it in Settings → Model Providers.`);
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    case 'ollama':
    default: {
      return createOllama({ baseURL: ollamaBaseUrl() })(modelId, modelSettings);
    }
  }
}

function supportsOllamaReasoning(modelId) {
  return /qwen3|deepseek-r1|phi4-reasoning/i.test(modelId || '');
}

// Convert Hive tool definitions (OpenAI-style function defs from getToolDefinitions)
// into AI SDK tools WITHOUT an execute fn — so the SDK surfaces the tool call
// instead of running it. Hive's own loop executes tools and feeds results back.
function toAiSdkTools(toolDefs) {
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) return undefined;
  const tools = {};
  for (const def of toolDefs) {
    const fn = def?.function;
    if (!fn?.name) continue;
    tools[fn.name] = {
      description: fn.description || '',
      inputSchema: jsonSchema(fn.parameters || { type: 'object', properties: {} }),
    };
  }
  return Object.keys(tools).length ? tools : undefined;
}

// Normalize one decoded Ollama /api/chat NDJSON object into Hive stream events.
function* emitOllamaEvents(obj) {
  const msg = obj && obj.message;
  if (msg) {
    if (msg.thinking) yield { type: 'thinking', delta: msg.thinking };
    if (msg.content) yield { type: 'content', delta: msg.content };
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        // Ollama tool calls carry no id; mint one so the loop can correlate
        // the eventual tool result (matches the AI SDK path's call.id contract).
        yield {
          type: 'tool_call',
          call: { id: crypto.randomUUID(), function: { name: tc.function?.name || 'tool', arguments: tc.function?.arguments ?? {} } },
        };
      }
    }
  }
  if (obj && obj.done) {
    yield { type: 'done', reason: obj.done_reason || 'stop', stats: ollamaStats(obj) };
  }
}

// Hive-owned Ollama streaming path. ai-sdk-ollama does NOT forward an abort
// signal to its HTTP client, so an aborted run leaves the Ollama generation
// running server-side (the root cause of the staff-chat 180s hangs, #37). We
// call /api/chat directly with the real AbortSignal so Stop actually closes the
// socket, and parse the NDJSON stream ourselves into the normalized events.
async function* streamOllama(modelId, { messages, tools, options = {}, signal } = {}) {
  if (signal?.aborted) throw abortError();

  const body = { model: modelId, messages: toOllamaMessages(messages || []), stream: true };
  const ollamaTools = toOllamaTools(tools);
  if (ollamaTools) body.tools = ollamaTools;
  if (options.reasoning != null && supportsOllamaReasoning(modelId)) body.think = !!options.reasoning;
  const opts = {};
  if (options.temperature != null) opts.temperature = options.temperature;
  if (options.num_ctx != null) opts.num_ctx = options.num_ctx;
  if (options.num_predict != null) opts.num_predict = options.num_predict;
  if (Object.keys(opts).length) body.options = opts;

  let res;
  try {
    res = await fetch(ollamaApiUrl('chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw abortError();
    throw e;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch {} /* error body is best-effort */
    throw new Error(`Ollama request failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }

  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; } /* skip partial/garbage lines */
        yield* emitOllamaEvents(obj);
      }
    }
    const tail = buf.trim();
    if (tail) { try { yield* emitOllamaEvents(JSON.parse(tail)); } catch {} /* trailing non-JSON */ }
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw abortError();
    throw e;
  } finally {
    // Release the socket promptly on early exit (abort / caller break).
    try { await res.body?.cancel?.(); } catch {} /* stream may already be closed */
  }
}

// Stream one model round. Async generator yielding normalized events:
//   { type:'content',  delta }
//   { type:'thinking', delta }
//   { type:'tool_call', call: { id, function: { name, arguments } } }
//   { type:'done', reason, stats }
// Mirrors what the call sites used to accumulate from Ollama NDJSON. Ollama runs
// on the Hive-owned direct path (real abort); cloud/gateway use the AI SDK.
async function* streamChat(modelString, { messages, tools, options = {}, signal } = {}) {
  const { provider, modelId } = parseModel(modelString);
  if (provider === 'ollama') {
    yield* streamOllama(modelId, { messages, tools, options, signal });
    return;
  }

  const model = getModel(provider, modelId, { metadata: options.metadata, gatewayKey: options.gatewayKey });
  const { system, rest } = splitSystem(messages || []);

  const result = streamText({
    model,
    system,
    messages: toModelMessages(rest),
    tools: toAiSdkTools(tools),
    abortSignal: signal,
    ...(options.temperature != null ? { temperature: options.temperature } : {}),
    ...(options.num_predict != null ? { maxOutputTokens: options.num_predict } : {}),
    // Single model round; Hive runs its own tool loop (tools have no execute).
  });

  // Cloud/gateway providers DO honor abortSignal, but we still race reads against
  // the signal so consumption returns immediately rather than awaiting a final
  // chunk after Stop.
  if (signal?.aborted) throw abortError();

  let onAbort = null;
  const aborted = signal
    ? new Promise((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;
  if (aborted) aborted.catch(() => {}); // avoid unhandled rejection warnings

  const iterator = result.fullStream[Symbol.asyncIterator]();
  try {
    while (true) {
      const step = aborted
        ? await Promise.race([iterator.next(), aborted])
        : await iterator.next();
      if (step.done) break;
      const part = step.value;
      switch (part.type) {
        case 'text':
        case 'text-delta':
          if (part.text) yield { type: 'content', delta: part.text };
          break;
        case 'reasoning':
        case 'reasoning-delta':
          if (part.text) yield { type: 'thinking', delta: part.text };
          break;
        case 'tool-call':
          yield {
            type: 'tool_call',
            call: { id: part.toolCallId, function: { name: part.toolName, arguments: part.input } },
          };
          break;
        case 'finish':
          yield { type: 'done', reason: part.finishReason || 'stop', stats: mapUsage(part.totalUsage) };
          break;
        case 'error':
          throw (part.error instanceof Error ? part.error : new Error(String(part.error?.message || part.error)));
      }
    }
  } finally {
    if (signal && onAbort) {
      try { signal.removeEventListener('abort', onAbort); } catch {}
    }
    // Detach from the abandoned stream; ignore errors from the dangling request.
    if (signal?.aborted) {
      try { iterator.return?.(); } catch {}
    }
  }
}

// One-shot, tool-free text generation across providers. Accumulates the content
// deltas from streamChat. Used for short reasoning tasks (e.g. the operator
// proposing a model plan) where Hive's full tool loop is unnecessary.
async function generateText(modelString, messages, { signal, temperature, num_ctx, metadata } = {}) {
  let out = '';
  for await (const part of streamChat(modelString, {
    messages,
    options: { ...(temperature != null ? { temperature } : {}), ...(num_ctx != null ? { num_ctx } : {}), ...(metadata ? { metadata } : {}) },
    signal,
  })) {
    if (part.type === 'content') out += part.delta;
  }
  return out.trim();
}

module.exports = {
  parseModel,
  keyFor,
  hasKey,
  gatewayConfig,
  ensureAgentGatewayKey,
  getModel,
  toAiSdkTools,
  streamChat,
  generateText,
  getSetting,
  ollamaBaseUrl,
  KEY_SETTING,
  ENV_VAR,
  LABEL,
  supportsOllamaReasoning,
};
