// The Sentinel — turns Hive telemetry into deduplicated health-forum threads.
// Every sweep (5 min) computes findings, each with a stable fingerprint:
// one finding = one forum thread, bumped in place (≤1/hour) while it persists,
// resolved + archived after it stays clear for two consecutive sweeps.
// computeFindings is pure (inputs → findings) so the detection rules are
// unit-testable without Discord or live telemetry.
const db = require('../../db');
const { getGatewaySpendSummary } = require('../gatewaySpend');
const gatewayHealth = require('../gatewayHealth');
const { getRecentLogs } = require('../logger');
const { getOllamaUrl } = require('../ollamaUrl');
const { listAgents } = require('../agentParser');
const workItems = require('../colonyWorkItems');
const { logger } = require('../logger');
const bindings = require('./bindings');
const { truncate } = require('./format');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BUMP_INTERVAL_MS = 60 * 60 * 1000;
const RESOLVE_AFTER_MISSES = 2;
const RECENT_RUN_WINDOW_S = 6 * 60 * 60; // errored runs within 6h stay actionable

const SEVERITY_ICONS = { alert: '🔴', warning: '🟡', suggestion: '💡' };

// ── Detection rules (pure) ────────────────────────────────────────────────────
function computeFindings({ spend, gateway, logs = [], erroredRuns = [], blockers = [], unroutedCount = 0, ollama = null } = {}) {
  const findings = [];

  // Budget burn: agents at ≥80% of their cap warn, ≥100% alert.
  for (const agent of spend?.agents || []) {
    if (!(agent.budget_usd > 0)) continue;
    const ratio = agent.spend_usd / agent.budget_usd;
    if (ratio < 0.8) continue;
    findings.push({
      fingerprint: `spend:${agent.agent_id}`,
      severity: ratio >= 1 ? 'alert' : 'warning',
      title: `${agent.agent_name || agent.agent_id} at ${Math.round(ratio * 100)}% of budget`,
      body: `Gateway spend for **${agent.agent_name || agent.agent_id}** is $${agent.spend_usd.toFixed(4)} of a $${agent.budget_usd.toFixed(2)} cap${ratio >= 1 ? ' — the gateway is now rejecting its requests' : ''}.`,
      evidence: { agent_id: agent.agent_id, spend_usd: agent.spend_usd, budget_usd: agent.budget_usd, ratio: Number(ratio.toFixed(3)) },
    });
  }

  // Gateway configured but unreachable.
  if (gateway?.enabled && gateway.reachable === false) {
    findings.push({
      fingerprint: 'gateway:unreachable',
      severity: 'alert',
      title: 'LLM gateway unreachable',
      body: `The configured LiteLLM gateway is not responding. ${gateway.message || ''}`.trim(),
      evidence: { message: gateway.message || null, checked_at: gateway.checked_at || null },
    });
  }

  // Ollama unreachable while local models are in use.
  if (ollama && ollama.inUse && !ollama.reachable) {
    findings.push({
      fingerprint: 'ollama:unreachable',
      severity: 'alert',
      title: 'Ollama unreachable',
      body: `Agents are configured with Ollama models but ${ollama.url} is not responding.`,
      evidence: { url: ollama.url },
    });
  }

  // Repeated error-log signatures (≥3 of the same component:event in the ring).
  const signatures = new Map();
  for (const entry of logs) {
    if (entry.level !== 'error') continue;
    if (entry.component === 'discord') continue; // don't feed the bridge's own noise back into itself
    const key = `${entry.component}:${entry.event}`;
    const sig = signatures.get(key) || { count: 0, last: null };
    sig.count++;
    sig.last = entry;
    signatures.set(key, sig);
  }
  for (const [key, sig] of signatures) {
    if (sig.count < 3) continue;
    findings.push({
      fingerprint: `logs:${key}`,
      severity: 'warning',
      title: `Repeated errors: ${key} (×${sig.count})`,
      body: `The server logged \`${key}\` ${sig.count} times recently.`,
      evidence: { signature: key, count: sig.count, last: sig.last },
    });
  }

  // Runs that ended in error.
  for (const run of erroredRuns) {
    findings.push({
      fingerprint: `run_error:${run.id}`,
      severity: 'alert',
      title: `Mission failed: ${truncate(run.team_name || run.goal || run.id, 60)}`,
      body: `Run \`${run.id}\`${run.team_name ? ` (team **${run.team_name}**)` : ''} ended in error.\n> ${truncate(run.goal || '', 200)}${run.summary ? `\n${truncate(run.summary, 300)}` : ''}`,
      evidence: { run_id: run.id, team_id: run.team_id || null, goal: run.goal || '', summary: run.summary || null },
    });
  }

  // Blockers posted by live crews.
  for (const blocker of blockers) {
    findings.push({
      fingerprint: `blocker:${blocker.colony_id}`,
      severity: 'warning',
      title: `Colony blocked: ${truncate(blocker.team_name || blocker.colony_id, 60)}`,
      body: `A crew member (${blocker.agent || 'unknown'}) raised a blocker on run \`${blocker.colony_id}\`:\n> ${truncate(blocker.content || '', 400)}`,
      evidence: { colony_id: blocker.colony_id, agent: blocker.agent || null, content: truncate(blocker.content || '', 800) },
    });
  }

  // Idle work: unrouted items waiting for a home.
  if (unroutedCount > 0) {
    findings.push({
      fingerprint: 'unrouted:items',
      severity: 'suggestion',
      title: `${unroutedCount} unrouted work item${unroutedCount === 1 ? '' : 's'}`,
      body: `${unroutedCount} work item${unroutedCount === 1 ? ' is' : 's are'} sitting in the Unrouted tray with no colony assigned. Route or dismiss them on the roster.`,
      evidence: { count: unroutedCount },
    });
  }

  return findings;
}

// ── KPI / metric cards (pure) ─────────────────────────────────────────────────
// Findings only appear when something is wrong ("no news is good news"), which
// is why a healthy install shows an empty health forum. Metrics are the other
// half: one PERSISTENT thread per KPI whose starter card is edited in place as
// the value changes — the "how are things going" view. Pure so it's testable.
function computeMetrics({ spend, gateway, ollama, teamsCount = 0, runningCount = 0, agentsCount = 0, runStats = {}, recentRuns = [] } = {}) {
  const metrics = [];
  const total = runStats.total || 0;
  const done = runStats.done || 0;
  const errored = runStats.error || 0;
  const successRate = total > 0 ? Math.round((done / total) * 100) : null;

  const gatewayLine = gateway?.enabled
    ? (gateway.reachable === false ? '🔴 unreachable' : '🟢 reachable')
    : 'not configured';
  const ollamaLine = ollama?.inUse ? (ollama.reachable ? '🟢 reachable' : '🔴 unreachable') : 'not in use';

  metrics.push({
    fingerprint: 'kpi:overview',
    title: 'System overview',
    body: [
      '**System overview**',
      `Colonies: **${teamsCount}** · Missions running: **${runningCount}**`,
      `Agents: **${agentsCount}**`,
      `LLM gateway: ${gatewayLine} · Ollama: ${ollamaLine}`,
    ].join('\n'),
  });

  metrics.push({
    fingerprint: 'kpi:missions',
    title: 'Mission stats',
    body: [
      '**Mission stats** (all time)',
      `Total runs: **${total}**`,
      `✅ Completed: **${done}** · 🔴 Errored: **${errored}** · 🟢 Running: **${runningCount}**`,
      successRate != null ? `Success rate: **${successRate}%**` : 'Success rate: —',
    ].join('\n'),
  });

  if (spend?.enabled) {
    const top = (spend.agents || []).filter(a => a.spend_usd > 0).slice(0, 5);
    metrics.push({
      fingerprint: 'kpi:spend',
      title: 'Gateway spend',
      body: [
        '**Gateway spend**',
        `Total: **$${Number(spend.totals?.spend_usd || 0).toFixed(4)}** · ${spend.totals?.calls || 0} calls · ${spend.totals?.tokens || 0} tokens`,
        ...(top.length
          ? ['', 'Top spenders:', ...top.map(a => `• ${a.agent_name}: $${a.spend_usd.toFixed(4)}${a.budget_usd ? ` / $${a.budget_usd.toFixed(2)}` : ''}`)]
          : ['', '_No spend recorded yet._']),
      ].join('\n'),
    });
  }

  if (recentRuns.length) {
    const icon = { done: '✅', error: '🔴', running: '🟢', stopped: '🟡' };
    metrics.push({
      fingerprint: 'kpi:activity',
      title: 'Recent missions',
      body: [
        '**Recent missions**',
        ...recentRuns.map(r => `${icon[r.status] || '⚪'} ${r.team_name ? `**${r.team_name}** · ` : ''}${truncate(r.goal || r.id, 80)}`),
      ].join('\n'),
    });
  }

  return metrics;
}

// ── Telemetry gathering ───────────────────────────────────────────────────────
async function gatherInputs() {
  const inputs = {};
  try { inputs.spend = await getGatewaySpendSummary(); } catch { inputs.spend = null; }
  try { inputs.gateway = gatewayHealth.getGatewayStatus(); } catch { inputs.gateway = null; }
  try { inputs.logs = getRecentLogs(200); } catch { inputs.logs = []; }
  try {
    inputs.erroredRuns = db.prepare(`
      SELECT c.id, c.goal, c.summary, c.team_id, t.name AS team_name
      FROM colonies c LEFT JOIN colony_teams t ON t.id=c.team_id
      WHERE c.status='error' AND c.updated_at >= unixepoch() - ?
      ORDER BY c.updated_at DESC LIMIT 10
    `).all(RECENT_RUN_WINDOW_S);
  } catch { inputs.erroredRuns = []; }
  try {
    inputs.blockers = db.prepare(`
      SELECT b.colony_id, b.agent, b.content, t.name AS team_name
      FROM colony_blackboard b
      JOIN colonies c ON c.id=b.colony_id AND c.status='running'
      LEFT JOIN colony_teams t ON t.id=c.team_id
      WHERE b.entry_type='blocker'
      ORDER BY b.id DESC LIMIT 10
    `).all();
  } catch { inputs.blockers = []; }
  try { inputs.unroutedCount = workItems.listUnroutedItems().length; } catch { inputs.unroutedCount = 0; }
  // KPI inputs (metrics view). Best-effort; a failed query just omits that card.
  try { inputs.teamsCount = db.prepare('SELECT COUNT(*) AS n FROM colony_teams').get().n; } catch { inputs.teamsCount = 0; }
  try { inputs.runningCount = db.prepare("SELECT COUNT(*) AS n FROM colonies WHERE status='running'").get().n; } catch { inputs.runningCount = 0; }
  try {
    inputs.runStats = db.prepare("SELECT COUNT(*) AS total, SUM(status='done') AS done, SUM(status='error') AS error FROM colonies").get();
  } catch { inputs.runStats = { total: 0, done: 0, error: 0 }; }
  try { inputs.agentsCount = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE ephemeral=0 OR ephemeral IS NULL').get().n; } catch { inputs.agentsCount = 0; }
  try {
    inputs.recentRuns = db.prepare(`
      SELECT c.id, c.status, c.goal, t.name AS team_name
      FROM colonies c LEFT JOIN colony_teams t ON t.id=c.team_id
      ORDER BY c.created_at DESC LIMIT 5
    `).all();
  } catch { inputs.recentRuns = []; }
  inputs.ollama = await probeOllama();
  return inputs;
}

async function probeOllama() {
  let inUse = false;
  try { inUse = listAgents({ includeEphemeral: true }).some(a => String(a.model || '').startsWith('ollama')); } catch { /* agents unreadable → skip probe */ }
  if (!inUse) return { inUse: false, reachable: true, url: null };
  const url = getOllamaUrl();
  try {
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(3000) });
    return { inUse, reachable: res.ok, url };
  } catch {
    return { inUse, reachable: false, url };
  }
}

// ── Posting ───────────────────────────────────────────────────────────────────
let client = null;
let sweepTimer = null;
const lastBumpAt = new Map();   // fingerprint → ts
const missCounts = new Map();   // fingerprint → consecutive sweeps absent

async function fetchForum() {
  const binding = bindings.getBinding('health_forum');
  if (!binding || !client) return null;
  try {
    const channel = await client.channels.fetch(binding.channel_id);
    return channel?.threads ? channel : null;
  } catch {
    return null;
  }
}

function findingStarter(finding) {
  return [
    finding.body,
    '',
    '```json',
    JSON.stringify({ fingerprint: finding.fingerprint, severity: finding.severity, ...finding.evidence }, null, 2),
    '```',
    '-# Reply here to triage — I can investigate or file a GitHub issue on the Hive repo.',
  ].join('\n');
}

async function postFinding(forum, finding) {
  const existingId = bindings.threadIdForRef('health', finding.fingerprint);
  if (existingId) {
    const last = lastBumpAt.get(finding.fingerprint) || 0;
    if (Date.now() - last < BUMP_INTERVAL_MS) return;
    try {
      const thread = await client.channels.fetch(existingId);
      if (thread?.isThread?.()) {
        if (thread.archived) await thread.setArchived(false).catch(() => {});
        await thread.send({ content: `🔁 Still firing — ${truncate(finding.title, 200)}` });
        lastBumpAt.set(finding.fingerprint, Date.now());
        return;
      }
    } catch { /* thread gone → recreate below */ }
    bindings.deleteThread(existingId);
  }
  const icon = SEVERITY_ICONS[finding.severity] || '🟡';
  const thread = await forum.threads.create({
    name: truncate(`${icon} ${finding.title}`, 96),
    message: { content: truncate(findingStarter(finding), 1990) },
  });
  bindings.saveThread(thread.id, 'health', finding.fingerprint);
  lastBumpAt.set(finding.fingerprint, Date.now());
  logger.info('discord', 'health_finding_posted', { fingerprint: finding.fingerprint, severity: finding.severity });
}

// Ensure one persistent thread per KPI, editing its starter card in place when
// the value changes. Never bumps or spams — a metric whose card is unchanged is
// left untouched, so "updated when there are updates" holds literally.
async function syncMetric(forum, metric) {
  const desired = truncate(metric.body, 1990);
  const existingId = bindings.threadIdForRef('health', metric.fingerprint);
  if (existingId) {
    try {
      const thread = await client.channels.fetch(existingId);
      if (thread?.isThread?.()) {
        if (thread.archived) await thread.setArchived(false).catch(() => {});
        const starter = await thread.fetchStarterMessage().catch(() => null);
        if (starter?.editable && starter.content !== desired) {
          await starter.edit({ content: desired }).catch(() => {});
        }
        return;
      }
    } catch { /* thread gone → recreate below */ }
    bindings.deleteThread(existingId);
  }
  const thread = await forum.threads.create({
    name: truncate(`📊 ${metric.title}`, 96),
    message: { content: desired },
  });
  bindings.saveThread(thread.id, 'health', metric.fingerprint);
  logger.info('discord', 'health_metric_posted', { fingerprint: metric.fingerprint });
}

async function resolveCleared(activeFingerprints) {
  for (const row of bindings.listThreads('health')) {
    // KPI threads are permanent — they track live metrics, not transient
    // conditions, so they are never auto-resolved/archived.
    if (String(row.ref).startsWith('kpi:')) continue;
    if (activeFingerprints.has(row.ref)) {
      missCounts.delete(row.ref);
      continue;
    }
    const misses = (missCounts.get(row.ref) || 0) + 1;
    missCounts.set(row.ref, misses);
    if (misses < RESOLVE_AFTER_MISSES) continue;
    try {
      const thread = await client.channels.fetch(row.thread_id);
      if (thread?.isThread?.()) {
        await thread.send({ content: '✅ **Resolved** — this condition has cleared. Archiving.' }).catch(() => {});
        await thread.setArchived(true).catch(() => {});
      }
    } catch { /* thread already gone */ }
    bindings.deleteThread(row.thread_id);
    missCounts.delete(row.ref);
    lastBumpAt.delete(row.ref);
  }
}

async function sweep() {
  if (!client) return;
  const forum = await fetchForum();
  if (!forum) return;
  const inputs = await gatherInputs();
  // Persistent KPI threads first, so a fresh install shows the metrics view even
  // when nothing is wrong.
  for (const metric of computeMetrics(inputs)) {
    try { await syncMetric(forum, metric); } catch (e) {
      logger.error('discord', 'health_metric_failed', { fingerprint: metric.fingerprint, error: e.message });
    }
  }
  const findings = computeFindings(inputs);
  for (const finding of findings) {
    try { await postFinding(forum, finding); } catch (e) {
      logger.error('discord', 'health_post_failed', { fingerprint: finding.fingerprint, error: e.message });
    }
  }
  await resolveCleared(new Set(findings.map(f => f.fingerprint)));
}

function start(discordClient) {
  client = discordClient;
  const first = setTimeout(() => sweep().catch(e => logger.error('discord', 'sweep_failed', { error: e.message })), 20_000);
  first.unref?.();
  sweepTimer = setInterval(() => sweep().catch(e => logger.error('discord', 'sweep_failed', { error: e.message })), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function stop() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  client = null;
}

// Health thread starter content is regenerable for triage context.
function findingContext(threadId) {
  const info = bindings.threadInfo(threadId);
  return info?.kind === 'health' ? info.ref : null;
}

module.exports = { computeFindings, computeMetrics, sweep, start, stop, findingContext, SWEEP_INTERVAL_MS };
