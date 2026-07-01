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

// Annotate model entries (from listOllama) with { tools } in parallel.
async function annotateToolSupport(entries, ollamaUrl) {
  return Promise.all(entries.map(async (e) => ({
    ...e,
    tools: await supportsTools(e.name, ollamaUrl),
  })));
}

function _resetForTests() {
  cache.clear();
}

module.exports = { getCapabilities, supportsTools, annotateToolSupport, _resetForTests };
