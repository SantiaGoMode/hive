// ── Provider dispatcher ───────────────────────────────────────────────────────
// Wraps the Vercel AI SDK so the rest of Hive can stream chat from any provider
// (Ollama, Anthropic, OpenAI, Gemini) through one interface, routed by the model
// id prefix. Both call sites (runAgentOnce, websocket) consume streamChat() and
// see the same normalized event shape they accumulated from Ollama NDJSON before.

const { streamText, jsonSchema } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { createOllama } = require('ai-sdk-ollama');
const db = require('../../db');
const { getOllamaUrl } = require('../ollamaUrl');
const { resolveSecret } = require('../secrets');
const { getSetting, onSettingsCacheInvalidated } = require('../config');
const {
  parseModel, splitSystem, toModelMessages, mapUsage,
} = require('./adapters');
const { logSwallowed } = require('../logSwallowed');

// app_settings key + env var fallback per cloud provider.
const KEY_SETTING = { anthropic: 'anthropic_api_key', openai: 'openai_api_key', gemini: 'gemini_api_key' };
const ENV_VAR     = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const LABEL        = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' };

let gatewayConfigCache = null;

function invalidateGatewayConfigCache() {
  gatewayConfigCache = null;
}

onSettingsCacheInvalidated(invalidateGatewayConfigCache);

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
  const envUrl = process.env.LLM_GATEWAY_URL;
  const envKey = process.env.LLM_GATEWAY_KEY;
  if (gatewayConfigCache && gatewayConfigCache.envUrl === envUrl && gatewayConfigCache.envKey === envKey) {
    return gatewayConfigCache.value;
  }
  const url = (envUrl || getSetting('llm_gateway_url') || '').trim();
  if (!url) {
    gatewayConfigCache = { envUrl, envKey, value: { enabled: false, url: '', key: '' } };
    return gatewayConfigCache.value;
  }
  const key = (envKey || resolveSecret(getSetting('llm_gateway_key')) || '').trim();
  gatewayConfigCache = { envUrl, envKey, value: { enabled: true, url, key: key || 'sk-hive-gateway' } };
  return gatewayConfigCache.value;
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
      try { db.prepare('UPDATE agents SET gateway_key=? WHERE id=?').run(key, agent.id); } catch (e) { logSwallowed('providers:saveGatewayKey', e, { agentId: agent.id }); }
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

// ai-sdk-ollama never forwards streamText's abortSignal to the underlying
// ollama client, so an abort would leave the HTTP request running to
// completion server-side. Injecting the signal at the fetch layer guarantees
// abort actually tears down the socket.
function abortableFetch(signal) {
  return (input, init = {}) => {
    const merged = init.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([init.signal, signal])
      : signal;
    return fetch(input, { ...init, signal: merged });
  };
}

// Build an AI SDK model instance for a parsed model.
function getModel(provider, modelId, settings = {}) {
  // metadata, a per-agent gateway key, and the abort signal ride alongside model
  // settings but aren't model settings; strip them before passing the rest on.
  const { metadata, gatewayKey, signal, ...modelSettings } = settings;
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
      return createOllama({
        baseURL: ollamaBaseUrl(),
        ...(signal ? { fetch: abortableFetch(signal) } : {}),
      })(modelId, modelSettings);
    }
  }
}

// Strip OpenAI "harmony" control tokens that some Ollama/MLX builds leak as raw
// text instead of parsing into reasoning/content channels. Observed with
// gemma4-mlx, which emitted "<|channel>thought" (a malformed marker missing its
// closing pipe) as the ENTIRE reasoning content for a round — surfacing as a
// garbage "model thinking" bubble. Removes both well-formed (<|channel|>) and
// malformed (<|channel>) variants, plus a leading channel-name preamble
// (analysis/final/commentary/thought) before the message so real reasoning text
// is preserved and only the scaffolding is dropped.
function sanitizeModelText(str) {
  if (!str) return str;
  return String(str)
    // <|channel|>analysis<|message|>  →  ''  (keep the text that follows)
    .replace(/<\|channel\|?>\s*(?:analysis|final|commentary|thought)?\s*(?:<\|message\|?>)?/gi, '')
    // any remaining special tokens, well-formed or malformed
    .replace(/<\|[a-z0-9_]+\|>/gi, '')
    .replace(/<\|[a-z0-9_]+>/gi, '')
    .replace(/<\|[a-z0-9_]+\|/gi, '');
}

// After sanitizing, reasoning that is empty or just a bare channel name carries
// no information — used to suppress the degenerate "<|channel>thought" bubble.
function isBlankReasoning(str) {
  const t = sanitizeModelText(str || '').trim();
  return !t || /^(analysis|final|thought|commentary|assistant|channel|message)$/i.test(t);
}

// Name-based fallback for old Ollama versions that don't report capabilities.
// The live check below prefers the model's actual probed capabilities — this
// regex once silently disabled thinking for every reasoning model not on the
// list (gemma4 shipped with thinking support and streamed none of it).
function supportsOllamaReasoning(modelId) {
  return /qwen3|deepseek-r1|phi4-reasoning|gemma4/i.test(modelId || '');
}

// Capability-first reasoning check: trust the cached /api/show probe when it
// answers; fall back to the name heuristic when capabilities are unknown.
async function ollamaModelCanThink(modelId) {
  try {
    const { getCapabilities } = require('./ollamaCapabilities');
    const caps = await getCapabilities(modelId, ollamaBaseUrl());
    if (Array.isArray(caps) && caps.length > 0) return caps.includes('thinking');
  } catch { /* probe unavailable — fall back to the heuristic */ }
  return supportsOllamaReasoning(modelId);
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

// Stream one model round. Async generator yielding normalized events:
//   { type:'content',  delta }
//   { type:'thinking', delta }
//   { type:'tool_call', call: { id, function: { name, arguments } } }
//   { type:'done', reason, stats }
// Mirrors what the call sites used to accumulate from Ollama NDJSON.
async function* streamChat(modelString, { messages, tools, options = {}, signal } = {}) {
  const { provider, modelId } = parseModel(modelString);
  const modelSettings = {};
  if (provider === 'ollama' && options.reasoning != null && await ollamaModelCanThink(modelId)) {
    modelSettings.think = !!options.reasoning;
  }
  const model = getModel(provider, modelId, { ...modelSettings, metadata: options.metadata, gatewayKey: options.gatewayKey, signal });
  const { system, rest } = splitSystem(messages || []);

  const providerOptions = {};
  if (provider === 'ollama') {
    // Preserve Ollama-specific knobs (context window etc.).
    const ollama = {};
    if (options.num_ctx != null) ollama.num_ctx = options.num_ctx;
    if (Object.keys(ollama).length) providerOptions.ollama = ollama;
  }

  const result = streamText({
    model,
    system,
    messages: toModelMessages(rest),
    tools: toAiSdkTools(tools),
    abortSignal: signal,
    ...(options.temperature != null ? { temperature: options.temperature } : {}),
    ...(options.num_predict != null ? { maxOutputTokens: options.num_predict } : {}),
    ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
    // Single model round; Hive runs its own tool loop (tools have no execute).
  });

  // For Ollama the abort signal is injected at the fetch layer (see
  // abortableFetch), so aborting closes the actual socket. The read race below
  // stays as defense in depth: it returns control to the caller immediately
  // even if a provider swallows the cancellation.
  const abortError = () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
  };
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
      try { signal.removeEventListener('abort', onAbort); } catch {} /* listener may already be removed */
    }
    // Detach from the abandoned stream; ignore errors from the dangling request.
    if (signal?.aborted) {
      try { iterator.return?.(); } catch {} /* aborted stream cleanup is best-effort */
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
  invalidateGatewayConfigCache,
  ollamaBaseUrl,
  KEY_SETTING,
  ENV_VAR,
  LABEL,
  supportsOllamaReasoning,
  sanitizeModelText,
  isBlankReasoning,
};
