// Lib-level mission control for the bridge: launch a team mission (the
// non-HTTP twin of POST /api/colony/teams/:tid/queue/:itemId/start) and inject
// a direction into a live run (twin of POST /api/colony/:id/directions). Kept
// here so the Operator agent's tools and the route handlers share the same
// underlying calls (createColony/claimWorkItem/runColony) without an HTTP hop.
const db = require('../../db');
const { createColony, runColony, stopColonyRun } = require('../colonyRunner');
const { getBus, hasBus, maybeCleanup } = require('../colonyBus');
const { notifyRoster } = require('../rosterBus');
const colonyModels = require('../colonyModels');
const colonyTeams = require('../colonyTeams');
const workItems = require('../colonyWorkItems');
const protocol = require('../colonyProtocol');
const { activeRuns } = require('../../routes/colony/shared');
const { logger } = require('../logger');

function activeRunForTeam(teamId) {
  return db.prepare(
    "SELECT id, goal, created_at FROM colonies WHERE team_id=? AND status='running' ORDER BY created_at DESC LIMIT 1",
  ).get(teamId) || null;
}

// Create a queued work item from a thread instruction and start it now. The
// operator's message IS the explicit launch action. Returns { runId, item }.
function launchTeamMission(teamId, direction, { model, source = 'manual', matchReason = 'Discord thread instruction' } = {}) {
  const team = colonyTeams.getTeam(teamId);
  if (!team) throw new Error('Colony team not found');
  const trimmed = String(direction || '').trim();
  if (!trimmed) throw new Error('The mission needs a direction');
  if (!model) throw new Error('No model available to run the mission');
  if (activeRunForTeam(team.id)) throw new Error('The team is already running a mission — send a direction instead');

  const gate = colonyModels.gatePlan({ operator: model }, team.cloud_enabled);
  if (!gate.ok) throw new Error(gate.error);

  const item = workItems.createWorkItem({
    teamId: team.id,
    source,
    direction: trimmed,
    status: 'queued',
    matchReason,
  });

  const colonyId = createColony(trimmed, model, team.recipe_id, {
    repoPath: team.repo_path || null,
    boardCard: null,
    cloudEnabled: team.cloud_enabled,
    githubWriteback: team.github_writeback,
    modelPlan: null,
    reasoningMode: 'auto',
    teamId: team.id,
  });
  workItems.claimWorkItem(item.id, colonyId, trimmed);

  // Same background-run shape as the bootstrap-accept route: register in the
  // shared activeRuns map so /api/colony/:id/stop keeps working, run detached.
  const ac = new AbortController();
  activeRuns.set(colonyId, ac);
  notifyRoster('run_started', { run_id: colonyId });
  setImmediate(async () => {
    try {
      await runColony(colonyId, null, ac.signal);
    } catch (e) {
      logger.error('discord', 'mission_run_failed', { colonyId, error: e?.message || String(e) });
      try {
        db.prepare("UPDATE colonies SET status='error', updated_at=unixepoch() WHERE id=? AND status='running'").run(colonyId);
      } catch { /* status reconcile is best-effort */ }
    } finally {
      activeRuns.delete(colonyId);
      maybeCleanup(colonyId);
      notifyRoster('run_finished', { run_id: colonyId });
    }
  });

  return { runId: colonyId, item };
}

// Queue work without starting it (team busy → backlog). Returns the item and
// its position among open queued items.
function queueTeamWork(teamId, direction, title = '') {
  const team = colonyTeams.getTeam(teamId);
  if (!team) throw new Error('Colony team not found');
  const item = workItems.createWorkItem({
    teamId: team.id,
    source: 'manual',
    title,
    direction: String(direction || '').trim(),
    status: 'queued',
    matchReason: 'queued from Discord',
  });
  const open = workItems.listWorkItems(team.id, { statuses: ['queued'] });
  return { item, position: Math.max(1, open.findIndex(i => i.id === item.id) + 1) };
}

// Inject a high-priority human direction into a live run; drained between
// review rounds. Mirrors POST /api/colony/:id/directions.
function sendDirection(colonyId, content, targetRole = null) {
  const colony = db.prepare('SELECT id, status FROM colonies WHERE id=?').get(colonyId);
  if (!colony) throw new Error('Run not found');
  if (colony.status !== 'running') throw new Error('Directions can only be sent to a running colony.');
  const trimmed = String(content || '').trim();
  if (!trimmed) throw new Error('Direction content is required');
  const info = db.prepare('INSERT INTO colony_directions (colony_id, content, target_role) VALUES (?, ?, ?)')
    .run(colony.id, trimmed, targetRole);
  protocol.writeBlackboard(colony.id, 'user', 'message', trimmed, {
    direction_id: info.lastInsertRowid, queued_for_operator: true, target_role: targetRole,
  });
  if (hasBus(colony.id)) {
    getBus(colony.id).emit('event', {
      type: 'direction_queued',
      direction: { id: info.lastInsertRowid, content: trimmed, target_role: targetRole },
    });
  }
  return { id: info.lastInsertRowid, status: 'queued' };
}

function stopTeamRun(teamId) {
  const active = activeRunForTeam(teamId);
  if (!active) return { stopped: false, message: 'No live run' };
  const stopped = stopColonyRun(active.id);
  const ac = activeRuns.get(active.id);
  if (ac) {
    try { ac.abort(); } catch { /* abort is best-effort */ }
    activeRuns.delete(active.id);
  }
  return { stopped: !!(stopped || ac), runId: active.id };
}

module.exports = {
  activeRunForTeam,
  launchTeamMission,
  queueTeamWork,
  sendDirection,
  stopTeamRun,
};
