// Colony schedules — recurring team missions stored in `scheduled_runs` with a
// team_id target (see migration 19). One source of truth for the three surfaces
// that manage them: the /hive schedule Discord command, the colony_operator
// tools (natural-language scheduling in a thread), and the web Schedules page
// (which uses the generic /api/schedules routes). The scheduler's team branch
// (scheduler.js) is what actually fires them.
const db = require('../db');
const cron = require('node-cron');
const scheduler = require('./scheduler');

function newScheduleId() {
  return `sch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Derive a short label from a prompt when the caller doesn't supply one.
function labelFromPrompt(prompt) {
  const oneLine = String(prompt || '').replace(/\s+/g, ' ').trim();
  return oneLine.slice(0, 48) || 'Scheduled mission';
}

// Create + register a recurring mission for a team. Throws on a bad cron or an
// empty prompt so callers surface a clear message. agent_id is '' (not NULL) to
// satisfy the NOT NULL column, matching the pipeline-target convention.
function createColonySchedule(teamId, { cronExpr, prompt, label } = {}) {
  if (!teamId) throw new Error('A colony team is required');
  const ce = String(cronExpr || '').trim();
  const p = String(prompt || '').trim();
  if (!cron.validate(ce)) throw new Error('Invalid cron expression (5-field, e.g. "0 9 * * 1" = Mondays 9am)');
  if (!p) throw new Error('A prompt/direction is required');
  const lbl = String(label || '').trim() || labelFromPrompt(p);
  const id = newScheduleId();
  db.prepare(
    'INSERT INTO scheduled_runs (id, agent_id, pipeline_id, team_id, label, cron_expr, prompt, enabled, tools) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
  ).run(id, '', null, teamId, lbl, ce, p, '[]');
  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id=?').get(id);
  scheduler.register(row);
  return row;
}

// Colony schedules only (team_id set). Optionally filtered to one team.
function listColonySchedules(teamId = null) {
  return teamId
    ? db.prepare('SELECT * FROM scheduled_runs WHERE team_id=? ORDER BY created_at DESC').all(teamId)
    : db.prepare("SELECT * FROM scheduled_runs WHERE team_id IS NOT NULL AND team_id!='' ORDER BY created_at DESC").all();
}

// A single colony schedule by id, or null if it doesn't exist / isn't a colony
// schedule. When scopeTeamId is given, also requires the row to belong to it.
function getColonySchedule(id, scopeTeamId = null) {
  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id=?').get(String(id || '').trim());
  if (!row || !row.team_id) return null;
  if (scopeTeamId && row.team_id !== scopeTeamId) return null;
  return row;
}

function removeColonySchedule(id, scopeTeamId = null) {
  const row = getColonySchedule(id, scopeTeamId);
  if (!row) return null;
  scheduler.unregister(row.id);
  db.prepare('DELETE FROM scheduled_runs WHERE id=?').run(row.id);
  return row;
}

// Pause/resume; re-registers so a disabled schedule stops firing immediately.
function setColonyScheduleEnabled(id, enabled, scopeTeamId = null) {
  const row = getColonySchedule(id, scopeTeamId);
  if (!row) return null;
  db.prepare('UPDATE scheduled_runs SET enabled=? WHERE id=?').run(enabled ? 1 : 0, row.id);
  const updated = db.prepare('SELECT * FROM scheduled_runs WHERE id=?').get(row.id);
  scheduler.register(updated);
  return updated;
}

module.exports = {
  labelFromPrompt,
  createColonySchedule,
  listColonySchedules,
  getColonySchedule,
  removeColonySchedule,
  setColonyScheduleEnabled,
};
