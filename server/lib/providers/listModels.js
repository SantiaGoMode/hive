// ── Unified model listing ─────────────────────────────────────────────────────
// Live-fetch chat/tool-capable models per provider when a key is configured,
// filtered to drop non-chat models, with a curated fallback when there is no key
// or the call fails. The picker also accepts free-text "provider/model" entry,
// so this list is a convenience, never a hard constraint.

const { keyFor, ollamaBaseUrl, gatewayConfig } = require('./index');
const { deriveGatewayAliases } = require('./gatewayAliases');

const TIMEOUT_MS = 6000;

// Conservative fallbacks (live fetch overrides these whenever a key works).
const FALLBACK = {
  anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-4o', 'gpt-4o-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
};

function entry(provider, modelId, source) {
  // Ollama keeps bare ids (back-compat with existing agents); clouds are prefixed.
  const id = provider === 'ollama' ? modelId : `${provider}/${modelId}`;
  return { id, provider, name: modelId, source };
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Per-provider live listers + filters ───────────────────────────────────────

async function listOllama() {
  try {
    const data = await fetchJson(`${ollamaBaseUrl()}/api/tags`);
    return (data.models || []).map(m => entry('ollama', m.name, 'live'));
  } catch {
    return []; // Ollama simply not running; no fallback list to invent.
  }
}

const OPENAI_DROP = /embedding|tts|whisper|audio|realtime|moderation|image|dall-e|transcribe|search|sora/i;
async function listOpenAI() {
  // With the gateway on, the real key lives in the proxy, not in Hive — list the
  // curated set rather than calling api.openai.com directly.
  if (gatewayConfig().enabled) return FALLBACK.openai.map(m => entry('openai', m, 'gateway'));
  const apiKey = keyFor('openai');
  if (!apiKey) return FALLBACK.openai.map(m => entry('openai', m, 'fallback'));
  try {
    const data = await fetchJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` });
    const ids = (data.data || [])
      .map(m => m.id)
      .filter(id => /^(gpt-|o\d|chatgpt)/i.test(id) && !OPENAI_DROP.test(id))
      .sort();
    return ids.length ? ids.map(id => entry('openai', id, 'live')) : FALLBACK.openai.map(m => entry('openai', m, 'fallback'));
  } catch {
    return FALLBACK.openai.map(m => entry('openai', m, 'fallback'));
  }
}

async function listAnthropic() {
  if (gatewayConfig().enabled) return FALLBACK.anthropic.map(m => entry('anthropic', m, 'gateway'));
  const apiKey = keyFor('anthropic');
  if (!apiKey) return FALLBACK.anthropic.map(m => entry('anthropic', m, 'fallback'));
  try {
    const data = await fetchJson('https://api.anthropic.com/v1/models?limit=100', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });
    const ids = (data.data || []).map(m => m.id).filter(id => /^claude/i.test(id)).sort().reverse();
    return ids.length ? ids.map(id => entry('anthropic', id, 'live')) : FALLBACK.anthropic.map(m => entry('anthropic', m, 'fallback'));
  } catch {
    return FALLBACK.anthropic.map(m => entry('anthropic', m, 'fallback'));
  }
}

async function listGemini() {
  if (gatewayConfig().enabled) return FALLBACK.gemini.map(m => entry('gemini', m, 'gateway'));
  const apiKey = keyFor('gemini');
  if (!apiKey) return FALLBACK.gemini.map(m => entry('gemini', m, 'fallback'));
  try {
    const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`);
    const ids = (data.models || [])
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => (m.name || '').replace(/^models\//, ''))
      .filter(id => /gemini/i.test(id) && !/embedding|aqa|image|tts/i.test(id))
      .sort();
    return ids.length ? ids.map(id => entry('gemini', id, 'live')) : FALLBACK.gemini.map(m => entry('gemini', m, 'fallback'));
  } catch {
    return FALLBACK.gemini.map(m => entry('gemini', m, 'fallback'));
  }
}

// Capability aliases served by the gateway (multi-provider failover pools).
// DERIVED from the model_name aliases in gateway/litellm.config.yaml (issue #38)
// so the picker can't drift from the gateway routing config. Computed once at
// module load; falls back to the known list if the yaml is missing/unparseable.
const GATEWAY_ALIASES = deriveGatewayAliases();
function listGateway() {
  if (!gatewayConfig().enabled) return [];
  return GATEWAY_ALIASES.map(a => entry('gateway', a, 'gateway'));
}

// Merged, provider-grouped list for the model picker.
async function listAllModels() {
  const [ollama, openai, anthropic, gemini] = await Promise.all([
    listOllama(), listOpenAI(), listAnthropic(), listGemini(),
  ]);
  return { gateway: listGateway(), ollama, anthropic, openai, gemini };
}

// Test a single provider's key by listing its models.
async function testProvider(provider) {
  // When the gateway is on, cloud keys live in the proxy — verify the proxy is
  // reachable rather than expecting a per-provider key in Hive.
  if (provider !== 'ollama' && gatewayConfig().enabled) {
    const { url, key } = gatewayConfig();
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, count: FALLBACK[provider]?.length || 0, source: 'gateway' };
      if (res.status === 401) return { ok: false, error: 'Gateway auth failed — check the gateway key in Settings' };
      return { ok: false, error: `Gateway HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: `Gateway unreachable: ${e.message}` };
    }
  }
  switch (provider) {
    case 'ollama': { const r = await listOllama(); return { ok: r.length > 0, count: r.length }; }
    case 'openai': { if (!keyFor('openai')) return { ok: false, error: 'No API key set' }; const r = await listOpenAI(); return { ok: r.some(m => m.source === 'live'), count: r.length }; }
    case 'anthropic': { if (!keyFor('anthropic')) return { ok: false, error: 'No API key set' }; const r = await listAnthropic(); return { ok: r.some(m => m.source === 'live'), count: r.length }; }
    case 'gemini': { if (!keyFor('gemini')) return { ok: false, error: 'No API key set' }; const r = await listGemini(); return { ok: r.some(m => m.source === 'live'), count: r.length }; }
    default: return { ok: false, error: `Unknown provider ${provider}` };
  }
}

module.exports = { listAllModels, testProvider, FALLBACK };
