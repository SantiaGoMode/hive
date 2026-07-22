const db = require('../db');
const { listLogEntries } = require('./colony/runEvents');

function safeParse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/[\\s_-]+/g, ' ').trim();
}

function roleMatchesProfile(profile, value) {
  const normalized = norm(value);
  return normalized && (
    normalized === norm(profile.role_key)
    || normalized === norm(profile.role)
    || normalized === norm(profile.display_name)
  );
}

function profileMetrics(profile) {
  const handoffs = db.prepare('SELECT * FROM colony_handoffs WHERE from_agent=? OR to_agent=?').all(profile.role_key, profile.role_key);
  // Dedupe identical handoffs: a looping worker once stacked 15 accepted
  // dev→QA handoffs with the same summary — counting those inflates the stat.
  const successKeys = new Set(
    handoffs
      .filter(h => ['pending', 'accepted', 'approved', 'awaiting_human'].includes(h.status))
      .map(h => `${h.colony_id}|${h.from_agent}|${h.to_agent}|${String(safeParse(h.payload, {})?.summary || '').trim()}`),
  );
  const successfulHandoffs = successKeys.size;
  const rejectedHandoffs = handoffs.filter(h => h.status === 'rejected' || h.protocol_status !== 'ok').length;
  const autoRecordedHandoffs = handoffs.filter(h => safeParse(h.payload, {})?.auto_recorded).length;
  const notes = db.prepare('SELECT * FROM colony_blackboard ORDER BY id DESC LIMIT 1000').all()
    .filter(e => roleMatchesProfile(profile, e.agent));
  const blockerCount = notes.filter(e => e.entry_type === 'blocker').length;
  const userComments = notes.filter(e => /^USER COMMENT/i.test(e.content || '')).length;
  const suggestions = db.prepare('SELECT status FROM staff_operator_suggestions WHERE profile_id=?').all(profile.id);
  const applied = suggestions.filter(s => s.status === 'applied').length;
  const logs = db.prepare('SELECT id FROM colonies ORDER BY created_at DESC LIMIT 100').all();
  let toolErrorCount = 0;
  let retryCount = 0; // loop-breaker trips (duplicate/identical-result/halt guards)
  for (const colony of logs) {
    for (const entry of listLogEntries(colony.id, { limit: 10000 })) {
      if (!roleMatchesProfile(profile, entry.agent)) continue;
      if (entry.kind === 'tool_result' && entry.result?.error) {
        toolErrorCount++;
        // Count breaker trips specifically — the old /retry/i regex over the
        // whole entry JSON matched noise (any prompt or result mentioning it).
        if (/Duplicate call detected|HALTED|IDENTICAL result/i.test(String(entry.result.error))) retryCount++;
      }
    }
  }
  return {
    successful_handoffs: successfulHandoffs,
    rejected_handoffs: rejectedHandoffs,
    auto_recorded_handoffs: autoRecordedHandoffs,
    blocker_count: blockerCount,
    tool_error_count: toolErrorCount,
    retry_count: retryCount,
    user_comments_received: userComments,
    suggestion_acceptance_rate: suggestions.length ? applied / suggestions.length : 0,
    average_useful_output_latency_ms: null,
  };
}

// Evidence behind each performance metric, so the UI can drill down from a
// count to the underlying handoffs, blockers, tool errors, etc.
function profileMetricDetails(profile, limit = 50) {
  const teamByRun = new Map(db.prepare('SELECT id, team_id FROM colonies').all().map(r => [r.id, r.team_id || null]));
  const handoffs = db.prepare('SELECT * FROM colony_handoffs WHERE from_agent=? OR to_agent=? ORDER BY created_at DESC')
    .all(profile.role_key, profile.role_key);
  const handoffRow = h => ({
    id: h.id,
    colony_id: h.colony_id,
    team_id: teamByRun.get(h.colony_id) || null,
    from_agent: h.from_agent,
    to_agent: h.to_agent,
    status: h.status,
    protocol_status: h.protocol_status,
    created_at: h.created_at,
  });

  const notes = db.prepare('SELECT * FROM colony_blackboard ORDER BY id DESC LIMIT 1000').all()
    .filter(e => roleMatchesProfile(profile, e.agent));
  const noteRow = e => ({
    id: e.id,
    colony_id: e.colony_id,
    team_id: teamByRun.get(e.colony_id) || null,
    agent: e.agent,
    entry_type: e.entry_type,
    content: String(e.content || '').slice(0, 500),
    created_at: e.created_at,
  });

  const toolErrors = [];
  const retries = [];
  for (const colony of db.prepare('SELECT id FROM colonies ORDER BY created_at DESC LIMIT 100').all()) {
    for (const entry of listLogEntries(colony.id, { limit: 10000 })) {
      if (!roleMatchesProfile(profile, entry.agent)) continue;
      if (entry.kind === 'tool_result' && entry.result?.error) {
        toolErrors.push({
          colony_id: colony.id,
          team_id: teamByRun.get(colony.id) || null,
          agent: entry.agent,
          tool: entry.tool || '',
          error: String(entry.result.error).slice(0, 300),
          ts: entry.ts || null,
        });
      }
      if (/retry/i.test(JSON.stringify(entry))) {
        retries.push({
          colony_id: colony.id,
          team_id: teamByRun.get(colony.id) || null,
          agent: entry.agent,
          kind: entry.kind || '',
          summary: String(entry.message || entry.tool || JSON.stringify(entry)).slice(0, 200),
          ts: entry.ts || null,
        });
      }
    }
  }

  return {
    successful_handoffs: handoffs.filter(h => ['pending', 'accepted', 'approved', 'awaiting_human'].includes(h.status)).slice(0, limit).map(handoffRow),
    rejected_handoffs: handoffs.filter(h => h.status === 'rejected' || h.protocol_status !== 'ok').slice(0, limit).map(handoffRow),
    auto_recorded_handoffs: handoffs.filter(h => safeParse(h.payload, {})?.auto_recorded).slice(0, limit).map(handoffRow),
    blocker_count: notes.filter(e => e.entry_type === 'blocker').slice(0, limit).map(noteRow),
    user_comments_received: notes.filter(e => /^USER COMMENT/i.test(e.content || '')).slice(0, limit).map(noteRow),
    tool_error_count: toolErrors.slice(0, limit),
    retry_count: retries.slice(0, limit),
  };
}

// Record which agent record was last seeded from a staff profile, so the
// profile can link back to its live worker agent.
function profileInteractions(profile, limit = 80) {
  const teamByRun = new Map(db.prepare('SELECT id, team_id FROM colonies').all().map(r => [r.id, r.team_id || null]));
  const handoffs = db.prepare('SELECT * FROM colony_handoffs WHERE from_agent=? OR to_agent=? ORDER BY created_at DESC LIMIT ?')
    .all(profile.role_key, profile.role_key, limit)
    .map(r => ({ type: 'handoff', ...r, team_id: teamByRun.get(r.colony_id) || null, payload: safeParse(r.payload, {}) }));
  const blackboard = db.prepare('SELECT * FROM colony_blackboard ORDER BY id DESC LIMIT 500').all()
    .filter(e => roleMatchesProfile(profile, e.agent))
    .slice(0, limit)
    .map(r => ({ type: 'blackboard', ...r, team_id: teamByRun.get(r.colony_id) || null, meta: safeParse(r.meta, {}) }));
  const histories = db.prepare(`
    SELECT h.colony_id, h.agent_id, h.updated_at, h.history, a.name, a.persona_role
    FROM colony_agent_histories h JOIN agents a ON a.id=h.agent_id
    ORDER BY h.updated_at DESC LIMIT 300
  `).all()
    .filter(r => roleMatchesProfile(profile, r.name) || roleMatchesProfile(profile, r.persona_role))
    .slice(0, 20)
    // Full conversation per run (capped at 100 turns) — the UI scrolls; do
    // not truncate to the last few messages.
    .map(r => ({ type: 'history', colony_id: r.colony_id, team_id: teamByRun.get(r.colony_id) || null, agent_id: r.agent_id, updated_at: r.updated_at, history: safeParse(r.history, []).slice(-100) }));
  return { handoffs, blackboard, histories };
}

function profileRunContext(profile, limit = 8) {
  const rows = db.prepare(`
    SELECT c.id, c.team_id, c.goal, c.status, c.summary, c.created_at, c.agent_ids,
           t.name AS team_name
    FROM colonies c
    LEFT JOIN colony_teams t ON t.id=c.team_id
    WHERE c.recipe_id=?
    ORDER BY c.created_at DESC
    LIMIT 80
  `).all(profile.recipe_id);
  const agentsById = new Map(db.prepare('SELECT id, name, persona_role FROM agents').all().map(a => [a.id, a]));
  return rows
    .filter(row => safeParse(row.agent_ids, []).some(id => {
      const agent = agentsById.get(id);
      return agent && (roleMatchesProfile(profile, agent.name) || roleMatchesProfile(profile, agent.persona_role));
    }))
    .slice(0, limit)
    .map(row => ({
      id: row.id,
      team_id: row.team_id || null,
      team_name: row.team_name || '',
      goal: row.goal,
      status: row.status,
      summary: row.summary || '',
      created_at: row.created_at,
    }));
}

// Per-run scorecard: what this role actually did and how it ended, one row per
// recent run it crewed — answers "is this staff member improving across runs?"
// with step outcomes, handoffs, real-work counts, and failure signals.
function profileRunScorecard(profile, limit = 15) {
  const colonies = db.prepare('SELECT id, team_id, recipe_id, status, created_at, plan FROM colonies ORDER BY created_at DESC LIMIT 60').all();
  const rows = [];
  for (const colony of colonies) {
    if (rows.length >= limit) break;
    if (profile.recipe_id && colony.recipe_id && colony.recipe_id !== profile.recipe_id) continue;
    const log = listLogEntries(colony.id, { limit: 10000 });
    const participated = log.some(e =>
      (e.kind === 'agent_ready' && (e.agent?.role_key === profile.role_key || e.agent?.name === profile.display_name))
      || roleMatchesProfile(profile, e.agent));
    if (!participated) continue;

    const stats = { tool_calls: 0, tool_errors: 0, breaker_trips: 0, files_written: 0, shell_commands: 0, silent_turns: 0 };
    for (const e of log) {
      if (roleMatchesProfile(profile, e.agent)) {
        if (e.kind === 'tool_call') {
          stats.tool_calls++;
          if (e.tool === 'write_file') stats.files_written++;
          if (e.tool === 'shell' || e.tool === 'run_python') stats.shell_commands++;
        }
        if (e.kind === 'tool_result' && e.result?.error) {
          stats.tool_errors++;
          if (/Duplicate call detected|HALTED|IDENTICAL result/i.test(String(e.result.error))) stats.breaker_trips++;
        }
      }
      // Silent turns surface on the operator side: ask_agent results naming
      // this worker with a no-output/halted marker as the response.
      if (e.kind === 'tool_result' && e.result?.agent_name && roleMatchesProfile(profile, e.result.agent_name)) {
        const resp = String(e.result.response || '');
        if (/^\((no response|agent reached max tool rounds|worker turn halted)/.test(resp)) stats.silent_turns++;
      }
    }

    const plan = safeParse(colony.plan, null);
    const own = (plan?.steps || []).filter(s => (s.assigned_to || null) === profile.role_key);
    const handoffs = db.prepare('SELECT * FROM colony_handoffs WHERE colony_id=? AND from_agent=?').all(colony.id, profile.role_key);
    const acceptedKeys = new Set(
      handoffs
        .filter(h => h.status !== 'rejected' && h.protocol_status === 'ok')
        .map(h => `${h.to_agent}|${String(safeParse(h.payload, {})?.summary || '').trim()}`),
    );

    rows.push({
      run_id: colony.id,
      team_id: colony.team_id || null,
      run_status: colony.status,
      created_at: colony.created_at,
      steps_assigned: own.length,
      steps_done: own.filter(s => s.status === 'done').length,
      steps_blocked: own.filter(s => s.status === 'blocked').length,
      handoffs_accepted: acceptedKeys.size,
      handoffs_rejected: handoffs.filter(h => h.status === 'rejected' || h.protocol_status !== 'ok').length,
      ...stats,
    });
  }
  return rows;
}


module.exports = {
  profileMetrics,
  profileMetricDetails,
  profileInteractions,
  profileRunContext,
  profileRunScorecard,
};
