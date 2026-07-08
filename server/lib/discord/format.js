// Pure formatting helpers for the Discord bridge: message chunking within
// Discord's 2000-char limit (code fences kept intact across chunks), the
// edited-in-place mission board, and the final status card. No discord.js
// imports — everything here is unit-testable.

const DISCORD_MESSAGE_LIMIT = 2000;

// Split text into Discord-sized chunks, preferring newline boundaries. An open
// ``` fence at a chunk boundary is closed and reopened in the next chunk so
// code blocks render correctly in every message.
function chunkMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  const full = String(text ?? '').trim();
  if (!full) return [];
  if (full.length <= limit) return [full];

  const chunks = [];
  // Reserve room for a closing fence we may need to append.
  const FENCE = '```';
  let rest = full;
  let openFenceLang = null; // null = not inside a fence; '' or 'lang' = inside

  while (rest.length > 0) {
    let head = (openFenceLang !== null ? `${FENCE}${openFenceLang}\n` : '');
    const budget = limit - head.length - (FENCE.length + 1); // room to close a fence
    let slice = rest.slice(0, Math.max(budget, 1));
    if (slice.length < rest.length) {
      const lastNewline = slice.lastIndexOf('\n');
      if (lastNewline > budget * 0.5) slice = slice.slice(0, lastNewline);
    }
    rest = rest.slice(slice.length).replace(/^\n/, '');

    // Track fence state across the slice.
    let inFence = openFenceLang !== null;
    let lang = openFenceLang || '';
    for (const line of slice.split('\n')) {
      const m = line.match(/^\s*```(\S*)\s*$/);
      if (!m) continue;
      if (inFence) { inFence = false; lang = ''; }
      else { inFence = true; lang = m[1] || ''; }
    }

    let chunk = head + slice;
    if (inFence && rest.length > 0) chunk += `\n${FENCE}`;
    openFenceLang = inFence && rest.length > 0 ? lang : null;
    chunks.push(chunk.trim());
  }
  return chunks.filter(Boolean);
}

// ── Mission board ─────────────────────────────────────────────────────────────
// One message, edited in place as plan_update events arrive.
const STEP_ICONS = {
  done: '✅',
  in_progress: '🔄',
  blocked: '❌',
  failed: '❌',
  pending: '⬜',
};

function missionBoard(plan, { goal = '', runId = '' } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const lines = ['**Mission board**'];
  if (goal) lines.push(`> ${truncate(goal, 200)}`);
  if (!steps.length) {
    lines.push('_Planning…_');
  } else {
    for (const step of steps) {
      const icon = STEP_ICONS[step.status] || STEP_ICONS.pending;
      lines.push(`${icon} ${truncate(step.description || step.id || 'step', 150)}`);
    }
    const done = steps.filter(s => s.status === 'done').length;
    lines.push(`\n${done}/${steps.length} steps done`);
  }
  if (runId) lines.push(`-# run \`${runId}\``);
  return lines.join('\n');
}

// ── Final status card ─────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function statusCard({ status, goal, steps = [], durationMs, summary = '', artifacts = [], spendUsd = null, runId = '' }) {
  const ok = status === 'done' || status === 'complete' || status === 'completed';
  const icon = ok ? '🟢' : status === 'stopped' ? '🟡' : '🔴';
  const done = steps.filter(s => s.status === 'done').length;
  const failed = steps.filter(s => s.status === 'blocked' || s.status === 'failed').length;

  const lines = [`${icon} **Mission ${ok ? 'complete' : status || 'ended'}**`];
  if (goal) lines.push(`> ${truncate(goal, 200)}`);
  const facts = [];
  if (steps.length) facts.push(`steps: ${done}/${steps.length} passed${failed ? `, ${failed} failed` : ''}`);
  if (Number.isFinite(durationMs)) facts.push(`duration: ${formatDuration(durationMs)}`);
  if (spendUsd != null) facts.push(`spend: $${Number(spendUsd).toFixed(4)}`);
  if (facts.length) lines.push(facts.join(' · '));
  for (const a of artifacts.slice(0, 8)) {
    lines.push(`📦 ${truncate(typeof a === 'string' ? a : (a.name || a.path || a.title || JSON.stringify(a)), 120)}`);
  }
  if (summary) lines.push(`\n${truncate(summary, 1400)}`);
  if (runId) lines.push(`-# run \`${runId}\``);
  return lines.join('\n');
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// Compact footer summarizing tool activity for a Steward/Operator turn:
// '🛠 web_search, sandbox ×2'
function toolFooter(toolNames = []) {
  if (!toolNames.length) return '';
  const counts = new Map();
  for (const name of toolNames) counts.set(name, (counts.get(name) || 0) + 1);
  const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return `-# 🛠 ${truncate(parts.join(', '), 180)}`;
}

module.exports = {
  DISCORD_MESSAGE_LIMIT,
  chunkMessage,
  missionBoard,
  statusCard,
  toolFooter,
  truncate,
  formatDuration,
};
