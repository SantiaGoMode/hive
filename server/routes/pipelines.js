const express = require('express');
const router = express.Router();
const db = require('../db');
const { readAgent } = require('../lib/agentParser');
const { runAgentOnce } = require('../lib/agentTools');

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

router.post('/', (req, res) => {
  const { name, description = '', steps = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = newId();
  db.prepare('INSERT INTO pipelines (id, name, description, steps) VALUES (?, ?, ?, ?)')
    .run(id, name, description, JSON.stringify(steps));
  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id);
  res.status(201).json({ ...row, steps: JSON.parse(row.steps) });
});

router.put('/:id', (req, res) => {
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

// Group consecutive parallel steps together.
// Returns: [{parallel: bool, indices: [0,1,...]}]
function groupSteps(steps) {
  const groups = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i].parallel) {
      const indices = [];
      while (i < steps.length && steps[i].parallel) { indices.push(i); i++; }
      groups.push({ parallel: true, indices });
    } else {
      groups.push({ parallel: false, indices: [i] });
      i++;
    }
  }
  return groups;
}

router.post('/:id/run', async (req, res) => {
  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  const steps = JSON.parse(row.steps);
  if (!steps.length) return res.status(400).json({ error: 'Pipeline has no steps' });

  const { input } = req.body;
  if (!input?.trim()) return res.status(400).json({ error: 'input is required' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // Prime the connection so the proxy knows it's a live stream
  res.write(': connected\n\n');

  const urlRow = db.prepare("SELECT value FROM app_settings WHERE key='ollama_url'").get();
  const ollamaUrl = urlRow?.value || 'http://localhost:11434';
  const hivePath = require('path').join(require('os').homedir(), '.hive');

  // Create a run record immediately
  const runId = newId();
  db.prepare(
    'INSERT INTO pipeline_runs (id, pipeline_id, pipeline_name, input, trace, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(runId, row.id, row.name, input.trim(), '[]', 'running');

  const pipelineStart = Date.now();
  let prevOutput = input.trim();
  const trace = [];
  const stepGroups = groupSteps(steps);

  for (let g = 0; g < stepGroups.length; g++) {
    const group = stepGroups[g];
    const groupPrev = prevOutput; // all steps in a parallel group see the same prev

    // Validate all agents in the group before starting any
    for (const idx of group.indices) {
      const step = steps[idx];
      const agent = readAgent(step.agent_id);
      const label = step.label || `Step ${idx + 1}`;
      if (!agent) {
        const entry = { step: idx, label, agent_name: step.agent_id, status: 'error', error: 'Agent not found', duration_ms: 0, group: g };
        trace.push(entry);
        db.prepare('UPDATE pipeline_runs SET trace=?, status=? WHERE id=?').run(JSON.stringify(trace), 'error', runId);
        emit({ type: 'step_error', ...entry });
        res.end(); return;
      }
      if (!agent.model) {
        const entry = { step: idx, label, agent_name: agent.name, status: 'error', error: 'No model configured', duration_ms: 0, group: g };
        trace.push(entry);
        db.prepare('UPDATE pipeline_runs SET trace=?, status=? WHERE id=?').run(JSON.stringify(trace), 'error', runId);
        emit({ type: 'step_error', ...entry });
        res.end(); return;
      }
    }

    if (!group.parallel) {
      // Sequential step
      const idx = group.indices[0];
      const step = steps[idx];
      const agent = readAgent(step.agent_id);
      const label = step.label || `Step ${idx + 1}`;
      const prompt = (step.prompt || '{prev}')
        .replace(/\{input\}/g, input.trim())
        .replace(/\{prev\}/g, groupPrev);

      emit({ type: 'step_start', step: idx, label, agent_name: agent.name, group: g });

      const stepStart = Date.now();
      let output, error;
      const stepToolsOverride = Array.isArray(step.tools) && step.tools.length > 0 ? step.tools : null;
      // Heartbeat keeps the SSE connection alive through reverse-proxy idle timeouts
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': heartbeat\n\n');
      }, 10000);
      try {
        output = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, hivePath, stepToolsOverride);
      } catch (e) { error = e.message; }
      finally { clearInterval(heartbeat); }
      const duration_ms = Date.now() - stepStart;

      if (error) {
        const entry = { step: idx, label, agent_name: agent.name, status: 'error', error, duration_ms, group: g };
        trace.push(entry);
        db.prepare('UPDATE pipeline_runs SET trace=?, status=? WHERE id=?').run(JSON.stringify(trace), 'error', runId);
        emit({ type: 'step_error', ...entry });
        res.end(); return;
      }
      trace.push({ step: idx, label, agent_name: agent.name, status: 'done', output, duration_ms, group: g });
      db.prepare('UPDATE pipeline_runs SET trace=? WHERE id=?').run(JSON.stringify(trace), runId);
      emit({ type: 'step_done', step: idx, label, agent_name: agent.name, output, duration_ms, group: g });
      prevOutput = output;

    } else {
      // Parallel group — emit step_start for all, then run concurrently
      for (const idx of group.indices) {
        const step = steps[idx];
        const agent = readAgent(step.agent_id);
        const label = step.label || `Step ${idx + 1}`;
        emit({ type: 'step_start', step: idx, label, agent_name: agent.name, group: g });
      }

      const parallelHeartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': heartbeat\n\n');
      }, 10000);
      const results = await Promise.all(
        group.indices.map(async (idx) => {
          const step = steps[idx];
          const agent = readAgent(step.agent_id);
          const label = step.label || `Step ${idx + 1}`;
          const prompt = (step.prompt || '{prev}')
            .replace(/\{input\}/g, input.trim())
            .replace(/\{prev\}/g, groupPrev);

          const stepStart = Date.now();
          const parallelToolsOverride = Array.isArray(step.tools) && step.tools.length > 0 ? step.tools : null;
          try {
            const output = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, hivePath, parallelToolsOverride);
            const duration_ms = Date.now() - stepStart;
            const entry = { step: idx, label, agent_name: agent.name, status: 'done', output, duration_ms, group: g };
            emit({ type: 'step_done', ...entry });
            return entry;
          } catch (e) {
            const duration_ms = Date.now() - stepStart;
            const entry = { step: idx, label, agent_name: agent.name, status: 'error', error: e.message, duration_ms, group: g };
            emit({ type: 'step_error', ...entry });
            return entry;
          }
        }),
      );

      clearInterval(parallelHeartbeat);

      // Collect all successful outputs; on any error stop pipeline
      const failed = results.find(r => r.status === 'error');
      trace.push(...results);
      db.prepare('UPDATE pipeline_runs SET trace=? WHERE id=?').run(JSON.stringify(trace), runId);
      if (failed) {
        db.prepare('UPDATE pipeline_runs SET status=? WHERE id=?').run('error', runId);
        res.end(); return;
      }
      // prevOutput for next group = all outputs joined
      prevOutput = results.map(r => r.output).join('\n\n---\n\n');
    }
  }

  const total_ms = Date.now() - pipelineStart;
  db.prepare(
    'UPDATE pipeline_runs SET trace=?, final_output=?, total_ms=?, status=? WHERE id=?',
  ).run(JSON.stringify(trace), prevOutput, total_ms, 'done', runId);

  emit({ type: 'done', final_output: prevOutput, total_ms });
  res.end();
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

  const emit = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  const urlRow = db.prepare("SELECT value FROM app_settings WHERE key='ollama_url'").get();
  const ollamaUrl = urlRow?.value || 'http://localhost:11434';
  const hivePath  = require('path').join(require('os').homedir(), '.hive');

  const prompt = (step.prompt || '{prev}')
    .replace(/\{input\}/g, input.trim())
    .replace(/\{prev\}/g,  prev_output);

  emit({ type: 'step_start', step: step_index, label, agent_name: agent.name });

  const stepStart = Date.now();
  const toolsOverride = Array.isArray(step.tools) && step.tools.length > 0 ? step.tools : null;
  try {
    const output = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, hivePath, toolsOverride);
    emit({ type: 'step_done', step: step_index, label, agent_name: agent.name, output, duration_ms: Date.now() - stepStart });
  } catch (e) {
    emit({ type: 'step_error', step: step_index, label, agent_name: agent.name, error: e.message, duration_ms: Date.now() - stepStart });
  }

  res.end();
});

module.exports = router;
