const express = require('express');
const router = express.Router();
const cron = require('node-cron');
const db = require('../db');
const scheduler = require('../lib/scheduler');
const colonyTeams = require('../lib/colonyTeams');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── List all ──────────────────────────────────────────────────────────────────
const parseSchedule = (row) => ({ ...row, tools: JSON.parse(row.tools || '[]') });

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM scheduled_runs ORDER BY created_at DESC').all();
  res.json(rows.map(parseSchedule));
});

// ── Get one ───────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Schedule not found' });
  res.json(parseSchedule(row));
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { agent_id, pipeline_id, team_id, label, cron_expr, prompt, enabled = true, tools = [] } = req.body;
  if (!agent_id && !pipeline_id && !team_id) return res.status(400).json({ error: 'agent_id, pipeline_id, or team_id is required' });
  if (!label)      return res.status(400).json({ error: 'label is required' });
  if (!cron_expr)  return res.status(400).json({ error: 'cron_expr is required' });
  if (!prompt)     return res.status(400).json({ error: 'prompt is required' });
  if (!cron.validate(cron_expr)) return res.status(400).json({ error: 'Invalid cron expression' });
  if (pipeline_id && !db.prepare('SELECT id FROM pipelines WHERE id = ?').get(pipeline_id)) {
    return res.status(400).json({ error: 'Pipeline not found' });
  }
  if (team_id && !colonyTeams.getTeam(team_id)) {
    return res.status(400).json({ error: 'Colony team not found' });
  }

  const id = newId();
  db.prepare(
    'INSERT INTO scheduled_runs (id, agent_id, pipeline_id, team_id, label, cron_expr, prompt, enabled, tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, (pipeline_id || team_id) ? '' : agent_id, pipeline_id || null, team_id || null, label, cron_expr, prompt, enabled ? 1 : 0, JSON.stringify(tools));

  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id);
  scheduler.register(row);
  res.status(201).json({ ...row, tools: JSON.parse(row.tools || '[]') });
});

// ── Update ────────────────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  const { agent_id, pipeline_id, team_id, label, cron_expr, prompt, enabled, tools } = req.body;
  if (cron_expr && !cron.validate(cron_expr)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }
  if (pipeline_id && !db.prepare('SELECT id FROM pipelines WHERE id = ?').get(pipeline_id)) {
    return res.status(400).json({ error: 'Pipeline not found' });
  }
  if (team_id && !colonyTeams.getTeam(team_id)) {
    return res.status(400).json({ error: 'Colony team not found' });
  }

  // Exactly one target type is active. Setting one explicitly clears the others.
  let nextAgentId = existing.agent_id || '';
  let nextPipelineId = existing.pipeline_id || null;
  let nextTeamId = existing.team_id || null;
  if (team_id !== undefined && team_id) {
    nextAgentId = ''; nextPipelineId = null; nextTeamId = team_id;
  } else if (pipeline_id !== undefined && pipeline_id) {
    nextAgentId = ''; nextPipelineId = pipeline_id; nextTeamId = null;
  } else if (agent_id !== undefined && agent_id) {
    nextAgentId = agent_id; nextPipelineId = null; nextTeamId = null;
  } else {
    if (agent_id !== undefined) nextAgentId = agent_id || '';
    if (pipeline_id !== undefined) nextPipelineId = pipeline_id || null;
    if (team_id !== undefined) nextTeamId = team_id || null;
  }
  if (!nextAgentId && !nextPipelineId && !nextTeamId) {
    return res.status(400).json({ error: 'agent_id, pipeline_id, or team_id is required' });
  }

  db.prepare(`
    UPDATE scheduled_runs
    SET agent_id=?, pipeline_id=?, team_id=?, label=?, cron_expr=?, prompt=?, enabled=?, tools=?
    WHERE id=?
  `).run(
    nextAgentId,
    nextPipelineId,
    nextTeamId,
    label     ?? existing.label,
    cron_expr ?? existing.cron_expr,
    prompt    ?? existing.prompt,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    tools !== undefined ? JSON.stringify(tools) : (existing.tools || '[]'),
    req.params.id,
  );

  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(req.params.id);
  scheduler.register(row);
  res.json({ ...row, tools: JSON.parse(row.tools || '[]') });
});

// ── Toggle enable/disable ────────────────────────────────────────────────────
router.post('/:id/toggle', (req, res) => {
  const existing = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  const newEnabled = existing.enabled ? 0 : 1;
  db.prepare('UPDATE scheduled_runs SET enabled=? WHERE id=?').run(newEnabled, req.params.id);

  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(req.params.id);
  scheduler.register(row); // re-register (will stop if disabled)
  res.json(parseSchedule(row));
});

// ── Run now ──────────────────────────────────────────────────────────────────
router.post('/:id/run-now', (req, res) => {
  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Schedule not found' });
  scheduler.runSchedule(row);
  res.json({ success: true, message: 'Run triggered in background' });
});

// ── Clear run history for one schedule ───────────────────────────────────────
router.delete('/:id/history', (req, res) => {
  db.prepare(
    'UPDATE scheduled_runs SET last_run=NULL, last_output=NULL, last_error=NULL, run_count=0 WHERE id=?',
  ).run(req.params.id);
  res.json({ success: true });
});

// ── Clear run history for ALL schedules ──────────────────────────────────────
router.delete('/history/all', (req, res) => {
  db.prepare(
    'UPDATE scheduled_runs SET last_run=NULL, last_output=NULL, last_error=NULL, run_count=0',
  ).run();
  res.json({ success: true });
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const { pruneOwnedAgents } = require('../lib/ownedAgents');
  const row = db.prepare('SELECT agent_id FROM scheduled_runs WHERE id = ?').get(req.params.id);
  scheduler.unregister(req.params.id);
  db.prepare('DELETE FROM scheduled_runs WHERE id = ?').run(req.params.id);
  // If this schedule directly owned a dedicated (ephemeral) agent target, delete
  // it too — unless a pipeline/staff/other schedule still relies on it. A
  // pipeline-target schedule leaves the pipeline (and its agents) untouched.
  const removed = row?.agent_id ? pruneOwnedAgents([row.agent_id], { exceptScheduleId: req.params.id }) : [];
  res.json({ success: true, deleted_agents: removed.length });
});

module.exports = router;
