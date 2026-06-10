// First-run starter-agent helpers (issue #2 — Guided First-Run Agent Setup).
// Pure functions only — UI lives in components/agents/StarterAgentBanner.jsx.
import { parseModelId } from './modelLabels';

export const STARTER_SYSTEM_PROMPT =
  'You are a helpful, friendly assistant. Give clear, concise answers, ask for clarification when a request is ambiguous, and save useful details about the user to memory when the memory tool is available.';

// "llama3.2:3b" → "Llama3.2 Assistant" · "anthropic/claude-sonnet-4-6" → "Claude Sonnet 4 6 Assistant"
export function starterAgentName(modelId = '') {
  const { model } = parseModelId(modelId);
  const base = (model.split(':')[0].split('/').pop() || '').replace(/[-_]+/g, ' ').trim();
  if (!base) return 'My First Agent';
  const pretty = base
    .split(' ')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
  return `${pretty} Assistant`;
}

// Sensible defaults for a first agent: memory on, moderate temperature,
// concise prompt. Advanced configuration stays available in the editor.
export function starterAgentDefaults(modelId) {
  return {
    name: starterAgentName(modelId),
    persona_role: 'General Assistant',
    description: 'Starter agent created during first-run setup. Customize it any time.',
    avatar_color: '#3b82f6',
    model: modelId,
    temperature: 0.7,
    max_tokens: 4096,
    context_length: 8192,
    tools: ['memory'],
    system_prompt: STARTER_SYSTEM_PROMPT,
  };
}

// Pick the best model for a starter agent from the grouped /api/models payload.
// Local-first: installed Ollama models, then gateway aliases, then cloud models
// with a live key. Curated "fallback" suggestions (no key set) are not usable.
export function pickStarterModel(grouped) {
  if (!grouped || typeof grouped !== 'object' || Array.isArray(grouped)) return null;
  const ollama = grouped.ollama || [];
  if (ollama.length > 0) return ollama[0].id;
  const gateway = grouped.gateway || [];
  if (gateway.length > 0) return gateway[0].id;
  for (const prov of ['anthropic', 'openai', 'gemini']) {
    const live = (grouped[prov] || []).filter(m => m.source === 'live');
    if (live.length > 0) return live[0].id;
  }
  return null;
}

// Where is this install in the first-run journey?
//   'loading'     — models not fetched yet, don't flash CTAs
//   'needs-model' — no agents and no usable model (pull one / add a key)
//   'needs-agent' — usable model exists but no agent yet
//   'complete'    — at least one agent exists
export function firstRunStage({ agents, groupedModels }) {
  if (Array.isArray(agents) && agents.length > 0) return 'complete';
  if (groupedModels == null) return 'loading';
  return pickStarterModel(groupedModels) ? 'needs-agent' : 'needs-model';
}
