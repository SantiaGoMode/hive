// Cached Ollama model-capability probes (/api/show). Colony planning and the
// model pickers need to know which local models support tool calling; probing
// every model on every list call would be slow, so results are cached per
// model name with a TTL (capabilities only change when a model is re-pulled).

const TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3000;
const cache = new Map(); // model name → { at, caps: string[] | null }

async function getCapabilities(model, ollamaUrl) {
  const hit = cache.get(model);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.caps;
  let caps = null; // null = unknown (old Ollama / probe failed) — treat as permissive
  try {
    const res = await fetch(`${ollamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const info = await res.json();
      caps = Array.isArray(info.capabilities) ? info.capabilities : null;
    }
  } catch { /* Ollama down or slow — leave unknown */ }
  cache.set(model, { at: Date.now(), caps });
  return caps;
}

// true / false, or null when unknown (callers should treat null as capable so
// an old Ollama without the capabilities field never empties the pool).
async function supportsTools(model, ollamaUrl) {
  const caps = await getCapabilities(model, ollamaUrl);
  if (!caps || caps.length === 0) return null;
  return caps.includes('tools');
}

// Media-generation models that are NOT usable as an agent's chat brain. Image
// models report caps like ['image'] (no 'completion') and are caught by the
// capability check below — but TTS/audio models such as Orpheus are Llama
// fine-tunes that DO report ['completion','tools'], so they slip past caps and
// need this name heuristic. Using one as an agent model yields garbage output
// (audio codes / confused text), so they're dropped from the model pickers.
const MEDIA_MODEL_RE = /\b(orpheus|tts|whisper|bark|xtts|kokoro|musicgen|melotts|piper|parler|vits|flux|flux2|sdxl|stable-?diffusion|dall-?e|snac|comfyui)\b/i;

// Is this model usable as a conversational agent brain? false for media/image/
// embedding models; null-caps (old Ollama) is treated as chat-capable, except
// for names that clearly denote a media generator.
function isChatModel(name, caps) {
  if (MEDIA_MODEL_RE.test(String(name || ''))) return false;
  if (Array.isArray(caps) && caps.length > 0) return caps.includes('completion');
  return true; // unknown capabilities → permissive
}

// Annotate model entries (from listOllama) with { tools, chat } in parallel,
// probing each model's capabilities once.
async function annotateToolSupport(entries, ollamaUrl) {
  return Promise.all(entries.map(async (e) => {
    const caps = await getCapabilities(e.name, ollamaUrl);
    const tools = (!caps || caps.length === 0) ? null : caps.includes('tools');
    return { ...e, tools, chat: isChatModel(e.name, caps) };
  }));
}

function _resetForTests() {
  cache.clear();
}

module.exports = { getCapabilities, supportsTools, isChatModel, annotateToolSupport, _resetForTests };
