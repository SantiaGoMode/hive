export function formatSummaryMarkdown(text) {
  let t = String(text || '').trim();
  if (!t) return t;
  if (!t.includes('\n')) {
    t = t
      .replace(/\s*\*\*([^*]+?)\*\*:?\s*(?=-\s|$)/g, '\n\n**$1**\n\n')   // sections followed by lists
      .replace(/\s-\s(?=[A-Z`*\d])/g, '\n- ');                            // " - item" → bullet
  }
  return t.trim();
}

// MCP tool names arrive as "<serverId>__tool_name" (e.g. "mpy8ho05arrw__create_directory").
// Strip the opaque server-id prefix for display.
export function prettyToolName(name) {
  return String(name || '').replace(/^[a-z0-9]{6,}__/i, '');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function ts(entry) {
  if (!entry.ts) return null;
  const d = new Date(entry.ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function preferredColonyModel(models) {
  const names = models.map(m => m.name);
  const preferred = [
    /^qwen2\.5:3b$/i,
    /^qwen2\.5:7b$/i,
    /^qwen3/i,
    /^mistral-nemo/i,
    /^mistral-small/i,
    /^llama3\.1/i,
    /^qwen2\.5:14b$/i,
    /^qwen2\.5:32b$/i,
    /^mistral:7b$/i,
    /^qwen2\.5:1\.5b$/i,
  ];
  for (const pattern of preferred) {
    const match = names.find(name => pattern.test(name));
    if (match) return match;
  }
  return names[0] || '';
}

// Flatten the provider-grouped model list ({ollama, anthropic, ...}) into a flat
// array, dropping cloud models when cloud is disabled.
export function flattenModels(grouped, cloudEnabled) {
  const out = [];
  for (const [prov, list] of Object.entries(grouped || {})) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const provider = m.provider || prov;
      if (!cloudEnabled && provider !== 'ollama') continue;
      out.push({ id: m.id, provider, name: m.name || m.id });
    }
  }
  return out;
}

export function preferredFlatModel(flat) {
  const ids = flat.map(m => m.id);
  return preferredColonyModel(flat.map(m => ({ name: m.id }))) || ids[0] || '';
}

export const PROVIDER_LABEL = { gateway: 'LLM Gateway (failover)', ollama: 'Local (Ollama)', anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' };

export const BOARD_LANES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

export function boardCardToGoal(card, notes = '') {
  if (!card) return notes.trim();
  return [
    '[Connected Repo Board Item]',
    `Provider: ${card.provider || 'github'}`,
    `Repository: ${card.repo || 'Unknown'}`,
    `Type: ${card.type || 'project_item'}`,
    card.number ? `Number: #${card.number}` : '',
    `Title: ${card.title}`,
    `Status: ${card.status || 'backlog'}`,
    card.status_label ? `Board status: ${card.status_label}` : '',
    card.labels?.length ? `Labels: ${card.labels.join(', ')}` : '',
    card.assignees?.length ? `Assignees: ${card.assignees.join(', ')}` : '',
    `Source: ${card.source || 'project board'}`,
    card.url ? `URL: ${card.url}` : '',
    '',
    'Description:',
    card.description || '(no description)',
    notes.trim() ? `\nAdditional session notes:\n${notes.trim()}` : '',
  ].filter(Boolean).join('\n');
}


export function parseBoardGoal(goal) {
  const text = String(goal || '').trim();
  if (!/^\[Connected Repo Board Item\]/.test(text)) return null;
  const lines = text.split('\n').slice(1);
  const fields = {};
  let descStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z ]*?):\s*(.*)$/);
    if (m && /^description$/i.test(m[1])) { descStart = i; break; }
    if (m) fields[m[1]] = m[2];
  }
  let description = '';
  let criteria = [];
  if (descStart !== -1) {
    const rest = lines.slice(descStart).join('\n').replace(/^Description:\s*/i, '');
    const parts = rest.split(/\n\s*Acceptance Criteria\s*\n?/i);
    description = parts[0].trim();
    if (parts[1]) {
      criteria = parts[1].split('\n').map(s => s.replace(/^[-*[\]\s]+/, '').trim()).filter(Boolean);
    }
  }
  return { fields, description, criteria };
}


export const STATUS_DOT = { running: 'bg-blue-400 animate-pulse', done: 'bg-green-400', stopped: 'bg-gray-600', awaiting_tasks: 'bg-amber-400', error: 'bg-red-400' };
export const STATUS_TEXT = { running: 'text-blue-400', done: 'text-green-400', stopped: 'text-gray-500', awaiting_tasks: 'text-amber-300', error: 'text-red-400' };

export function runLabel(run) {
  const item = parseBoardGoal(run.goal);
  const title = item
    ? `${item.fields.Number ? `${item.fields.Number} · ` : ''}${item.fields.Title || 'Work item'}`
    : String(run.goal || '').split('\n')[0];
  return title.slice(0, 90);
}

export function fmtDuration(secs) {
  if (secs == null) return '—';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}
