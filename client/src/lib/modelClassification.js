// Classify local Ollama models by what they can actually DO — specifically
// whether they can drive Hive agents (tool calling + enough capacity for
// multi-step work). Pure functions so the tiers are unit-testable.

// Families whose base variants advertise tool support but are unreliable at
// multi-step tool chains (mirrors the server preflight's weak-tool heuristic).
const WEAK_TOOL_RE = /^llama3(\.|:|-)|^llama-3(\.|:)|^mistral(?!-nemo|-small)/i;

export function parameterSizeB(model) {
  const raw = model?.details?.parameter_size || '';
  const m = String(raw).match(/([\d.]+)\s*B/i);
  if (m) return parseFloat(m[1]);
  const fromName = String(model?.name || '').match(/(\d+(?:\.\d+)?)b\b/i);
  return fromName ? parseFloat(fromName[1]) : null;
}

// Tier ids, best-first. Meaning:
//   agent-ready — tools + ≥7B + reliable family: can run colonies, pipelines,
//                 and multi-step tool work.
//   tools-light — advertises tool calling but small (<7B) or a family known to
//                 fumble multi-step chains: fine for single tool calls / chat.
//   chat-only   — no tool calling: chat and generation only, cannot drive agents.
//   embedding   — vector embedding model, not a chat model at all.
export const TIER_ORDER = ['agent-ready', 'tools-light', 'chat-only', 'embedding'];

export const TIER_META = {
  'agent-ready': {
    label: 'Agent-ready',
    description: 'Tool calling + enough capacity for multi-step work — can run colonies, pipelines, and scheduled agents.',
  },
  'tools-light': {
    label: 'Tools · light',
    description: 'Supports tool calling but small or historically weak at multi-step chains — fine for chat and single tool calls.',
  },
  'chat-only': {
    label: 'Chat only',
    description: 'No tool calling — cannot drive agents. Usable for plain chat and generation.',
  },
  embedding: {
    label: 'Embedding',
    description: 'Produces vectors, not text — for search/RAG, not chat.',
  },
};

export function classifyLocalModel(model) {
  const caps = Array.isArray(model?.capabilities) ? model.capabilities : [];
  const name = String(model?.name || '');
  if (caps.includes('embedding') || /embed/i.test(name)) return 'embedding';
  const hasTools = caps.includes('tools');
  if (!hasTools) return 'chat-only';
  const size = parameterSizeB(model);
  if ((size != null && size < 7) || WEAK_TOOL_RE.test(name)) return 'tools-light';
  return 'agent-ready';
}

// Capability badges to render for a model (beyond the tier).
export function capabilityBadges(model) {
  const caps = Array.isArray(model?.capabilities) ? model.capabilities : [];
  const out = [];
  if (caps.includes('tools')) out.push({ key: 'tools', label: 'Tools', color: 'green', hint: 'Function/tool calling — required for agents' });
  if (caps.includes('thinking')) out.push({ key: 'thinking', label: 'Reasoning', color: 'purple', hint: 'Extended thinking / chain-of-thought mode' });
  if (caps.includes('vision')) out.push({ key: 'vision', label: 'Vision', color: 'blue', hint: 'Understands images' });
  if (caps.includes('insert')) out.push({ key: 'insert', label: 'Code-fill', color: 'yellow', hint: 'Fill-in-the-middle code completion' });
  return out;
}

// Group + sort a flat installed-model list into render-ready tier sections:
// best tier first, larger models first within a tier.
export function groupModelsByTier(models, query = '') {
  const q = String(query || '').trim().toLowerCase();
  const filtered = (models || []).filter(m => !q || String(m.name).toLowerCase().includes(q));
  const groups = new Map(TIER_ORDER.map(t => [t, []]));
  for (const m of filtered) groups.get(classifyLocalModel(m)).push(m);
  for (const list of groups.values()) {
    list.sort((a, b) => (parameterSizeB(b) || 0) - (parameterSizeB(a) || 0) || String(a.name).localeCompare(String(b.name)));
  }
  return TIER_ORDER
    .map(tier => ({ tier, ...TIER_META[tier], models: groups.get(tier) }))
    .filter(g => g.models.length > 0);
}
