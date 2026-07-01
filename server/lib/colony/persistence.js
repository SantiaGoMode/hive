// Colony DB persistence: ID generation, JSON-column parsing, run-state writes,
// and the colony CRUD used by routes and tests.
const db = require('../../db');
const { readAgent } = require('../agentParser');
const { logSwallowed } = require('../logSwallowed');
const colonyModels = require('../colonyModels');
const { DEFAULT_RECIPE_ID } = require('../colonyRecipes');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Parse a JSON DB column with a fallback default. A parse failure means the
// persisted data is corrupt — worth logging (issue #26), but behavior is
// unchanged: the caller still gets the same fallback as before.
function parseField(json, field, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch (e) {
    logSwallowed('colonyRunner:parseRow', e, { field });
    return fallback;
  }
}

function addAgentToColony(colonyId, agentId) {
  const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(colonyId);
  if (!row) return;
  const ids = JSON.parse(row.agent_ids || '[]');
  if (!ids.includes(agentId)) {
    ids.push(agentId);
    db.prepare('UPDATE colonies SET agent_ids=?, updated_at=unixepoch() WHERE id=?')
      .run(JSON.stringify(ids), colonyId);
  }
}

function persistLog(colonyId, entries) {
  const json = JSON.stringify(entries);
  db.prepare('UPDATE colonies SET log=?, updated_at=unixepoch() WHERE id=?').run(json, colonyId);
}

function drainPendingDirections(colonyId) {
  const rows = db.prepare(`
    SELECT * FROM colony_directions
    WHERE colony_id=? AND status='queued'
    ORDER BY id ASC
  `).all(colonyId);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE colony_directions SET status='delivered', delivered_at=unixepoch() WHERE id IN (${placeholders})`).run(...ids);
  return rows;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function createColony(goal, model, recipeId = DEFAULT_RECIPE_ID, opts = {}) {
  const id = newId();
  db.prepare('INSERT INTO colonies (id, goal, model, recipe_id, repo_path, board_card, cloud_enabled, github_writeback, model_plan, reasoning_mode, trigger_config, trigger, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      id, goal, model, recipeId,
      opts.repoPath || null,
      opts.boardCard ? JSON.stringify(opts.boardCard) : null,
      opts.cloudEnabled ? 1 : 0,
      opts.githubWriteback ? 1 : 0,
      opts.modelPlan ? JSON.stringify(opts.modelPlan) : null,
      colonyModels.normalizeReasoningMode(opts.reasoningMode),
      opts.triggerConfig ? JSON.stringify(opts.triggerConfig) : null,
      opts.trigger ? JSON.stringify(opts.trigger) : null,
      opts.teamId || null,
    );
  return id;
}

function listColonies() {
  return db.prepare(
    'SELECT id, team_id, goal, model, recipe_id, status, orchestrator_id, agent_ids, summary, created_at, trigger, board_card FROM colonies ORDER BY created_at DESC',
  ).all().map(r => {
    const trigger = parseField(r.trigger, 'trigger', null);
    const boardCard = parseField(r.board_card, 'board_card', null);
    return { ...r, agent_ids: JSON.parse(r.agent_ids || '[]'), trigger, board_card: boardCard };
  });
}

function getColony(id) {
  const row = db.prepare('SELECT * FROM colonies WHERE id=?').get(id);
  if (!row) return null;
  const agents = JSON.parse(row.agent_ids || '[]').map(aid => {
    const a = readAgent(aid);
    return a ? { id: a.id, name: a.name, persona_role: a.persona_role, avatar_color: a.avatar_color, model: a.model, tools: a.tools } : null;
  }).filter(Boolean);
  const plan = parseField(row.plan, 'plan', null);
  const deliverable = parseField(row.deliverable, 'deliverable', null);
  const boardCard = parseField(row.board_card, 'board_card', null);
  const modelPlan = parseField(row.model_plan, 'model_plan', null);
  const triggerConfig = parseField(row.trigger_config, 'trigger_config', null);
  const trigger = parseField(row.trigger, 'trigger', null);
  const bootstrapTasks = parseField(row.bootstrap_tasks, 'bootstrap_tasks', null);
  return {
    ...row,
    agent_ids: JSON.parse(row.agent_ids || '[]'),
    agents,
    log: JSON.parse(row.log || '[]'),
    plan,
    deliverable,
    board_card: boardCard,
    cloud_enabled: !!row.cloud_enabled,
    model_plan: modelPlan,
    reasoning_mode: colonyModels.normalizeReasoningMode(row.reasoning_mode),
    trigger_config: triggerConfig,
    trigger,
    bootstrap_tasks: bootstrapTasks,
    bootstrap_accepted: !!row.bootstrap_accepted,
  };
}

function deleteColony(id) {
  const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(id);
  if (!row) return;
  const ids = JSON.parse(row.agent_ids || '[]');
  const { deleteAgent } = require('../agentParser');
  for (const agentId of ids) {
    try { deleteAgent(agentId); } catch (e) { logSwallowed('colonyRunner:deleteAgent', e, { agentId }); }
  }
  try { db.prepare('DELETE FROM colony_blackboard WHERE colony_id=?').run(id); } catch (e) { logSwallowed('colonyRunner:deleteRows', e, { table: 'colony_blackboard', colonyId: id }); }
  try { db.prepare('DELETE FROM colony_handoffs WHERE colony_id=?').run(id); } catch (e) { logSwallowed('colonyRunner:deleteRows', e, { table: 'colony_handoffs', colonyId: id }); }
  try { db.prepare('DELETE FROM colony_trigger_events WHERE colony_id=? OR triggered_colony_id=?').run(id, id); } catch (e) { logSwallowed('colonyRunner:deleteRows', e, { table: 'colony_trigger_events', colonyId: id }); }
  try { db.prepare('DELETE FROM colony_directions WHERE colony_id=?').run(id); } catch (e) { logSwallowed('colonyRunner:deleteRows', e, { table: 'colony_directions', colonyId: id }); }
  try { db.prepare('DELETE FROM colony_agent_histories WHERE colony_id=?').run(id); } catch (e) { logSwallowed('colonyRunner:deleteRows', e, { table: 'colony_agent_histories', colonyId: id }); }
  db.prepare('DELETE FROM colonies WHERE id=?').run(id);
}

module.exports = {
  newId,
  parseField,
  addAgentToColony,
  persistLog,
  drainPendingDirections,
  createColony,
  listColonies,
  getColony,
  deleteColony,
};
