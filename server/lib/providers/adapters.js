// ── Provider adapters (pure) ──────────────────────────────────────────────────
// Pure translation helpers between Hive's internal Ollama-shaped messages/tools
// and the Vercel AI SDK's ModelMessage / tool formats. No `ai` import here so
// these can be unit-tested without the SDK installed.

const crypto = require('crypto');
const { logSwallowed } = require('../logSwallowed');

// Providers we recognize as a model-id prefix. Anything else (or no prefix) is
// treated as Ollama, so existing bare model names keep working unchanged.
// "gateway/<alias>" routes a capability alias (e.g. gateway/hive-smart) through
// the LLM gateway as-is, so its multi-provider failover pool applies.
const KNOWN_PROVIDERS = ['ollama', 'anthropic', 'openai', 'gemini', 'gateway'];

// "anthropic/claude-..." -> { provider: 'anthropic', modelId: 'claude-...' }
// "llama3.1:8b"          -> { provider: 'ollama',    modelId: 'llama3.1:8b' }
// "ollama/llama3.1"      -> { provider: 'ollama',    modelId: 'llama3.1' }
function parseModel(modelString) {
  const s = (modelString || '').trim();
  const slash = s.indexOf('/');
  if (slash > 0) {
    const prefix = s.slice(0, slash);
    if (KNOWN_PROVIDERS.includes(prefix)) {
      return { provider: prefix, modelId: s.slice(slash + 1) };
    }
  }
  // No known prefix → Ollama (strip a leading "ollama/" if present).
  return { provider: 'ollama', modelId: s.replace(/^ollama\//, '') };
}

// Coerce tool-call arguments to a plain object. Ollama/cloud usually give an
// object; some small local models emit a JSON (or python-ish) string.
function normalizeArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch {} /* fall through to relaxed parse */
    try { return JSON.parse(raw.replace(/'/g, '"')); } catch (e) { logSwallowed('adapters:parseToolArgs', e); }
    return {};
  }
  return {};
}

function stringContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
  }
  return content == null ? '' : String(content);
}

// Map a user message's content (string or client part array) to AI SDK UserContent.
// Client parts: { type:'text', text } and { type:'image_url', image_url:{ url } }.
function toUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  const parts = [];
  for (const p of content) {
    if (!p || !p.type) continue;
    if (p.type === 'text') parts.push({ type: 'text', text: p.text || '' });
    else if (p.type === 'image_url') parts.push({ type: 'image', image: p.image_url?.url });
    else if (p.type === 'image') parts.push({ type: 'image', image: p.image ?? p.dataUrl });
  }
  return parts.length ? parts : '';
}

// Split a leading system message out of the Hive message list. The AI SDK prefers
// `system` as a top-level param (avoids prompt-injection warnings).
function splitSystem(messages) {
  let system;
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system' && system === undefined) system = stringContent(m.content);
    else rest.push(m);
  }
  return { system, rest };
}

// Convert Hive's Ollama-shaped messages to AI SDK ModelMessage[].
// Hive tool messages may carry tool_call_id + name (threaded through the loop so
// cloud providers can correlate calls↔results). If absent (legacy), we fall back
// to a generated id; correlation still holds within a single assistant turn
// because we generate ids in lockstep below.
function toModelMessages(messages) {
  const out = [];
  // FIFO of tool calls awaiting results: [{ id, name }]. A tool message uses its
  // explicit tool_call_id when present; otherwise it correlates by name, and
  // failing that by order. Reset whenever a new assistant turn issues tool calls.
  let pending = [];

  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: stringContent(m.content) });
      continue;
    }

    if (m.role === 'user') {
      out.push({ role: 'user', content: toUserContent(m.content) });
      continue;
    }

    if (m.role === 'assistant') {
      const text = stringContent(m.content);
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (calls.length === 0) {
        out.push({ role: 'assistant', content: text || '' });
        continue;
      }
      pending = [];
      const parts = [];
      if (text) parts.push({ type: 'text', text });
      for (const tc of calls) {
        const toolName = tc.function?.name || tc.name || 'tool';
        const toolCallId = tc.id || crypto.randomUUID();
        const args = normalizeArgs(tc.function?.arguments ?? tc.arguments);
        parts.push({ type: 'tool-call', toolCallId, toolName, input: args });
        pending.push({ id: toolCallId, name: toolName });
      }
      out.push({ role: 'assistant', content: parts });
      continue;
    }

    if (m.role === 'tool') {
      const explicitId = m.tool_call_id || m.toolCallId;
      const givenName = m.name || m.toolName;
      let slot;
      if (explicitId) {
        const i = pending.findIndex(p => p.id === explicitId);
        if (i >= 0) slot = pending.splice(i, 1)[0];
        else slot = { id: explicitId, name: givenName || 'tool' };
      } else if (givenName) {
        const i = pending.findIndex(p => p.name === givenName);
        if (i >= 0) slot = pending.splice(i, 1)[0];
      }
      if (!slot) slot = pending.shift() || { id: crypto.randomUUID(), name: givenName || 'tool' };

      let value;
      try { value = typeof m.content === 'string' ? JSON.parse(m.content) : m.content; }
      catch { value = m.content; }
      const output = (typeof value === 'string')
        ? { type: 'text', value }
        : { type: 'json', value: value ?? null };
      out.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: slot.id, toolName: slot.name, output }] });
      continue;
    }
  }
  return out;
}

// AI SDK LanguageModelUsage -> Hive stats shape used by the chat UI.
function mapUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
    // tps isn't provided by the SDK uniformly; left null (UI handles missing).
    tps: null,
  };
}

module.exports = {
  KNOWN_PROVIDERS,
  parseModel,
  normalizeArgs,
  stringContent,
  toUserContent,
  splitSystem,
  toModelMessages,
  mapUsage,
};
