// Cleanup for dedicated, run-scoped agents that a pipeline or schedule owns.
// These are marked ephemeral (so they're hidden from the Agents tab like colony
// crews) but, unlike colony crews, they're referenced by a fixed step/target id
// and must survive between runs — so they're pruned only when their owner is
// deleted, and only if nothing else still relies on them.
const db = require('../db');
const { readAgent, deleteAgent } = require('./agentParser');

// True only for an agent that is safe to delete on owner teardown: it's
// ephemeral (a dedicated run agent, not a user/staff agent) AND nothing else
// still points at it — no staff-profile assignment, no OTHER pipeline step, and
// no OTHER schedule agent-target.
function isOrphanEphemeralAgent(agentId, { exceptPipelineId = null, exceptScheduleId = null } = {}) {
  if (!agentId) return false;
  const agent = readAgent(agentId);
  if (!agent || !agent.ephemeral) return false;
  if (db.prepare('SELECT 1 FROM staff_profiles WHERE assigned_agent_id=? LIMIT 1').get(agentId)) return false;
  for (const p of db.prepare('SELECT id, steps FROM pipelines').all()) {
    if (p.id === exceptPipelineId) continue;
    if (String(p.steps || '').includes(agentId)) return false;
  }
  for (const s of db.prepare('SELECT id, agent_id FROM scheduled_runs').all()) {
    if (s.id === exceptScheduleId) continue;
    if (s.agent_id === agentId) return false;
  }
  return true;
}

// Delete each orphan-eligible agent in the list. Returns the ids removed.
function pruneOwnedAgents(agentIds, opts = {}) {
  const removed = [];
  for (const id of [...new Set((agentIds || []).filter(Boolean))]) {
    if (isOrphanEphemeralAgent(id, opts)) {
      try { deleteAgent(id); removed.push(id); } catch { /* best-effort cleanup */ }
    }
  }
  return removed;
}

// agent_ids referenced by a pipeline's steps JSON (raw string or parsed array).
function pipelineStepAgentIds(steps) {
  try {
    const arr = typeof steps === 'string' ? JSON.parse(steps || '[]') : (steps || []);
    return (Array.isArray(arr) ? arr : []).map(s => s && s.agent_id).filter(Boolean);
  } catch { return []; }
}

module.exports = { isOrphanEphemeralAgent, pruneOwnedAgents, pipelineStepAgentIds };
