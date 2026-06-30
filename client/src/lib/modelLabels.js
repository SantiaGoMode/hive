const PROVIDERS = {
  ollama: { label: 'Ollama', badge: 'Local', color: 'green' },
  anthropic: { label: 'Anthropic', badge: 'Claude', color: 'purple' },
  openai: { label: 'OpenAI', badge: 'GPT', color: 'blue' },
  gemini: { label: 'Google Gemini', badge: 'Gemini', color: 'yellow' },
  // Capability aliases routed through the LLM gateway (gateway/hive-smart, …).
  gateway: { label: 'LLM Gateway', badge: 'Gateway', color: 'teal' },
};

export function parseModelId(modelId = '') {
  const value = String(modelId || '').trim();
  const slash = value.indexOf('/');
  if (slash > 0) {
    const provider = value.slice(0, slash);
    if (PROVIDERS[provider]) {
      return { provider, model: value.slice(slash + 1), full: value };
    }
  }
  return { provider: 'ollama', model: value.replace(/^ollama\//, ''), full: value };
}

export function providerLabel(provider) {
  return PROVIDERS[provider]?.label || provider;
}

export function modelOptionLabel(entry) {
  const name = entry?.name || entry?.id || '';
  const source = ['fallback', 'live', 'gateway'].includes(entry?.source) ? entry.source : '';
  return source ? `${name} (${source})` : name;
}

export function modelBadge(modelId = '') {
  const parsed = parseModelId(modelId);
  const info = PROVIDERS[parsed.provider] || PROVIDERS.ollama;
  return {
    text: parsed.provider === 'ollama' ? parsed.model : `${info.badge}: ${parsed.model}`,
    title: parsed.full,
    color: info.color,
  };
}

export function hasAnyModelOption(groupedModels) {
  if (!groupedModels || Array.isArray(groupedModels)) return Array.isArray(groupedModels) && groupedModels.length > 0;
  return Object.values(groupedModels).some(list => Array.isArray(list) && list.length > 0);
}

// Display order for the model picker. Gateway first — the gateway/hive-* failover
// aliases are the recommended default; then local, then the cloud providers.
export const MODEL_PROVIDER_ORDER = ['gateway', 'ollama', 'anthropic', 'openai', 'gemini'];

// optgroup heading for a provider. Ollama is local; the gateway group is flagged
// recommended so the picker steers toward the failover aliases.
export function modelGroupHeading(provider) {
  if (provider === 'ollama') return 'Ollama (local)';
  if (provider === 'gateway') return `${providerLabel(provider)} (recommended)`;
  return providerLabel(provider);
}

// Normalize a grouped model map ({ provider: [entries] }) into ordered, non-empty
// [provider, entries] pairs — MODEL_PROVIDER_ORDER first (gateway promoted), then
// any other providers in their existing order. The single source of truth for how
// every model picker groups and orders its options.
export function orderedModelGroups(groupedModels) {
  if (!groupedModels || Array.isArray(groupedModels)) return [];
  const seen = new Set();
  const out = [];
  const take = (provider) => {
    const list = groupedModels[provider];
    if (Array.isArray(list) && list.length > 0) { out.push([provider, list]); seen.add(provider); }
  };
  for (const provider of MODEL_PROVIDER_ORDER) take(provider);
  for (const provider of Object.keys(groupedModels)) {
    if (!seen.has(provider)) take(provider);
  }
  return out;
}
