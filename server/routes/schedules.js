const express = require('express');
const router = express.Router();
const cron = require('node-cron');
const db = require('../db');
const scheduler = require('../lib/scheduler');

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
  const { agent_id, label, cron_expr, prompt, enabled = true, tools = [] } = req.body;
  if (!agent_id)   return res.status(400).json({ error: 'agent_id is required' });
  if (!label)      return res.status(400).json({ error: 'label is required' });
  if (!cron_expr)  return res.status(400).json({ error: 'cron_expr is required' });
  if (!prompt)     return res.status(400).json({ error: 'prompt is required' });
  if (!cron.validate(cron_expr)) return res.status(400).json({ error: 'Invalid cron expression' });

  const id = newId();
  db.prepare(
    'INSERT INTO scheduled_runs (id, agent_id, label, cron_expr, prompt, enabled, tools) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, agent_id, label, cron_expr, prompt, enabled ? 1 : 0, JSON.stringify(tools));

  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id);
  scheduler.register(row);
  res.status(201).json({ ...row, tools: JSON.parse(row.tools || '[]') });
});

// ── Update ────────────────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  const { agent_id, label, cron_expr, prompt, enabled, tools } = req.body;
  if (cron_expr && !cron.validate(cron_expr)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  db.prepare(`
    UPDATE scheduled_runs
    SET agent_id=?, label=?, cron_expr=?, prompt=?, enabled=?, tools=?
    WHERE id=?
  `).run(
    agent_id  ?? existing.agent_id,
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
  scheduler.unregister(req.params.id);
  db.prepare('DELETE FROM scheduled_runs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
