const express = require('express');
const router = express.Router();
const db = require('../db');
const { readAgent } = require('../lib/agentParser');
const { runAgentOnce } = require('../lib/agentTools');
const { abortError, isAbortError, runPipelineById } = require('../lib/pipelineRunner');
const { getOllamaUrl } = require('../lib/ollamaUrl');
const { validateBody, createPipelineSchema, updatePipelineSchema } = require('../lib/validate');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM pipelines ORDER BY updated_at DESC').all();
  res.json(rows.map(r => ({ ...r, steps: JSON.parse(r.steps) })));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });
  res.json({ ...row, steps: JSON.parse(row.steps) });
});

router.post('/', validateBody(createPipelineSchema), (req, res) => {
  const { name, description = '', steps = [] } = req.body;
  const id = newId();
  db.prepare('INSERT INTO pipelines (id, name, description, steps) VALUES (?, ?, ?, ?)')
    .run(id, name, description, JSON.stringify(steps));
  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id);
  res.status(201).json({ ...row, steps: JSON.parse(row.steps) });
});

router.put('/:id', validateBody(updatePipelineSchema), (req, res) => {
  const { name, description, steps } = req.body;
  const existing = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pipeline not found' });
  db.prepare('UPDATE pipelines SET name=?, description=?, steps=?, updated_at=unixepoch() WHERE id=?')
    .run(
      name ?? existing.name,
      description ?? existing.description,
      steps ? JSON.stringify(steps) : existing.steps,
      req.params.id,
    );
  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id);
  res.json({ ...row, steps: JSON.parse(row.steps) });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM pipelines WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Run history ───────────────────────────────────────────────────────────────
router.get('/:id/runs', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY ran_at DESC LIMIT 50',
  ).all(req.params.id);
  res.json(rows.map(r => ({ ...r, trace: JSON.parse(r.trace) })));
});

// Clear run history for one pipeline
router.delete('/:id/runs', (req, res) => {
  db.prepare('DELETE FROM pipeline_runs WHERE pipeline_id = ?').run(req.params.id);
  res.json({ success: true });
});

// Clear ALL pipeline run history (must be defined before /:id routes to avoid matching)
router.delete('/runs/all', (req, res) => {
  db.prepare('DELETE FROM pipeline_runs').run();
  res.json({ success: true });
});

// ── Run (SSE streaming) ───────────────────────────────────────────────────────
// Streams events as each step executes:
//   {type:'step_start',  step, label, agent_name, group}
//   {type:'step_done',   step, label, agent_name, output, duration_ms, group}
//   {type:'step_error',  step, label, agent_name, error,  duration_ms, group}
//   {type:'done',        final_output, total_ms}
//   {type:'stopped'}     — client closed connection early
//
// Steps with parallel:true are grouped — consecutive parallel steps run via Promise.all.
// After a parallel group, {prev} = all outputs joined with '\n\n---\n\n'.

router.post('/:id/run', async (req, res) => {
  const { input } = req.body;
  if (!input?.trim()) return res.status(400).json({ error: 'input is required' });

  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });
  const steps = JSON.parse(row.steps || '[]');
  if (!steps.length) return res.status(400).json({ error: 'Pipeline has no steps' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sawStopped = false;
  const emit = (obj) => {
    if (obj?.type === 'stopped') sawStopped = true;
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // Prime the connection so the proxy knows it's a live stream
  res.write(': connected\n\n');

  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished && !ctrl.signal.aborted) ctrl.abort();
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
  }, 10000);
  try {
    await runPipelineById(req.params.id, input, { emit, signal: ctrl.signal });
  } catch (e) {
    if (isAbortError(e, ctrl.signal)) {
      if (!sawStopped) emit({ type: 'stopped' });
    }
    else emit({ type: 'error', error: e.message });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

// ── Retry a single step (SSE) ─────────────────────────────────────────────────
// Runs one step in isolation given the caller-supplied prev_output and input.
// Streams: {type:'step_start'}, then {type:'step_done'} or {type:'step_error'}.
router.post('/:id/run-step', async (req, res) => {
  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  const steps = JSON.parse(row.steps);
  const { step_index, prev_output = '', input = '' } = req.body;

  if (typeof step_index !== 'number' || step_index < 0 || step_index >= steps.length) {
    return res.status(400).json({ error: 'Invalid step_index' });
  }

  const step  = steps[step_index];
  const agent = readAgent(step.agent_id);
  const label = step.label || `Step ${step_index + 1}`;

  if (!agent)       return res.status(400).json({ error: `Agent "${step.agent_id}" not found` });
  if (!agent.model) return res.status(400).json({ error: `Agent "${step.agent_id}" has no model configured` });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (obj) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished && !ctrl.signal.aborted) ctrl.abort();
  });

  const ollamaUrl = getOllamaUrl();
  const hivePath  = require('path').join(require('os').homedir(), '.hive');

  const prompt = (step.prompt || '{prev}')
    .replace(/\{input\}/g, input.trim())
    .replace(/\{prev\}/g,  prev_output);

  emit({ type: 'step_start', step: step_index, label, agent_name: agent.name });

  const stepStart = Date.now();
  const toolsOverride = Array.isArray(step.tools) && step.tools.length > 0 ? step.tools : null;
  try {
    if (ctrl.signal.aborted) throw abortError();
    const output = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, hivePath, toolsOverride, undefined, ctrl.signal);
    if (ctrl.signal.aborted) throw abortError();
    emit({ type: 'step_done', step: step_index, label, agent_name: agent.name, output, duration_ms: Date.now() - stepStart });
  } catch (e) {
    if (isAbortError(e, ctrl.signal)) {
      emit({ type: 'step_stopped', step: step_index, label, agent_name: agent.name, error: 'Pipeline step retry was stopped', duration_ms: Date.now() - stepStart });
      emit({ type: 'stopped' });
    } else {
      emit({ type: 'step_error', step: step_index, label, agent_name: agent.name, error: e.message, duration_ms: Date.now() - stepStart });
    }
  }

  if (!res.writableEnded && !res.destroyed) res.end();
});

module.exports = router;
