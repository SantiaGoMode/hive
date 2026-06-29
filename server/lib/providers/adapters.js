// ── Provider adapters (pure) ──────────────────────────────────────────────────
// Pure translation helpers between Hive's internal Ollama-shaped messages/tools
// and the Vercel AI SDK's ModelMessage / tool formats. No `ai` import here so
// these can be unit-tested without the SDK installed.

const crypto = require('crypto');

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
    try { return JSON.parse(raw); } catch {}
    try { return JSON.parse(raw.replace(/'/g, '"')); } catch {}
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

// ── Ollama /api/chat adapters (used by the Hive-owned direct streaming path) ───
// We talk to Ollama's native chat endpoint directly so an AbortSignal actually
// cancels the in-flight HTTP request (ai-sdk-ollama does not forward it). Hive
// messages are already Ollama-shaped, so conversion is mostly identity; the work
// is normalizing multimodal user content (data-URI images -> base64 `images[]`)
// and tool-call/result fields to what /api/chat expects.

// Ollama wants raw base64, not a `data:<mime>;base64,...` URI.
function stripDataUri(url) {
  const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(url || '');
  return m ? m[1] : (url || '');
}

function splitUserImages(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content == null ? '' : String(content), images: [] };
  const texts = [];
  const images = [];
  for (const p of content) {
    if (!p || !p.type) continue;
    if (p.type === 'text') texts.push(p.text || '');
    else if (p.type === 'image_url') { const u = p.image_url?.url; if (u) images.push(stripDataUri(u)); }
    else if (p.type === 'image') { const u = p.image ?? p.dataUrl; if (u) images.push(stripDataUri(u)); }
  }
  return { text: texts.join('\n'), images };
}

// Hive's Ollama-shaped messages -> Ollama /api/chat `messages` array.
function toOllamaMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'user') {
      const { text, images } = splitUserImages(m.content);
      const msg = { role: 'user', content: text };
      if (images.length) msg.images = images;
      out.push(msg);
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: stringContent(m.content) };
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (calls.length) {
        msg.tool_calls = calls.map(tc => ({
          function: {
            name: tc.function?.name || tc.name || 'tool',
            arguments: normalizeArgs(tc.function?.arguments ?? tc.arguments),
          },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      const msg = { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null) };
      const name = m.name || m.toolName;
      if (name) msg.tool_name = name;
      out.push(msg);
    } else {
      out.push({ role: m.role || 'user', content: stringContent(m.content) });
    }
  }
  return out;
}

// Hive tool definitions (OpenAI-style function defs) -> Ollama `tools` array.
function toOllamaTools(toolDefs) {
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) return undefined;
  const tools = [];
  for (const def of toolDefs) {
    const fn = def?.function;
    if (!fn?.name) continue;
    tools.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return tools.length ? tools : undefined;
}

// Ollama final-chunk metrics -> Hive stats shape. Durations are nanoseconds;
// tps = output tokens / generation seconds (eval_duration), rounded to 1dp.
function ollamaStats(final) {
  if (!final) return null;
  const outputTokens = final.eval_count ?? null;
  const evalDuration = final.eval_duration ?? null;
  const tps = (outputTokens != null && evalDuration)
    ? Math.round((outputTokens / (evalDuration / 1e9)) * 10) / 10
    : null;
  return { input_tokens: final.prompt_eval_count ?? null, output_tokens: outputTokens, tps };
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
  toOllamaMessages,
  toOllamaTools,
  ollamaStats,
};
