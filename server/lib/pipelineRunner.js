const path = require('path');
const os = require('os');
const db = require('../db');
const { readAgent } = require('./agentParser');
const { runAgentOnce } = require('./agentTools');
const { getOllamaUrl } = require('./ollamaUrl');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

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

function renderStepPrompt(step, input, prev) {
  return (step.prompt || '{prev}')
    .replace(/\{input\}/g, input)
    .replace(/\{prev\}/g, prev);
}

// Resolve a step's agent, applying the optional per-step model override —
// e.g. pointing one step at gateway/hive-coding while the agent defaults to
// a local model everywhere else.
function stepAgent(step) {
  const agent = readAgent(step.agent_id);
  if (!agent) return null;
  return step.model ? { ...agent, model: step.model } : agent;
}

// Keep the most recent runs per pipeline; unbounded history grew forever.
const MAX_RUNS_PER_PIPELINE = 100;
function pruneRuns(pipelineId) {
  db.prepare(`
    DELETE FROM pipeline_runs WHERE pipeline_id = ? AND id NOT IN (
      SELECT id FROM pipeline_runs WHERE pipeline_id = ? ORDER BY ran_at DESC, id DESC LIMIT ${MAX_RUNS_PER_PIPELINE}
    )`).run(pipelineId, pipelineId);
}

// Live-run gauge for /api/system/metrics.
let activeRuns = 0;
function activeRunCount() { return activeRuns; }

function abortError() {
  const err = new Error('Pipeline run was stopped');
  err.name = 'AbortError';
  return err;
}

function isAbortError(err, signal = null) {
  return signal?.aborted || err?.name === 'AbortError' || err?.message === 'Pipeline run was stopped' || err?.message === 'Colony run was stopped';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function runPipelineById(pipelineId, input, { emit = null, hivePath = null, signal = null, runContext = null } = {}) {
  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(pipelineId);
  if (!row) throw new Error('Pipeline not found');

  const steps = JSON.parse(row.steps || '[]');
  if (!steps.length) throw new Error('Pipeline has no steps');
  if (!input?.trim()) throw new Error('input is required');

  const cleanInput = input.trim();
  const ollamaUrl = getOllamaUrl();
  const resolvedHivePath = hivePath || process.env.HIVE_HOME || path.join(os.homedir(), '.hive');

  const runId = newId();
  db.prepare(
    'INSERT INTO pipeline_runs (id, pipeline_id, pipeline_name, input, trace, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(runId, row.id, row.name, cleanInput, '[]', 'running');
  pruneRuns(row.id);

  const pipelineStart = Date.now();
  let prevOutput = cleanInput;
  const trace = [];
  const stepGroups = groupSteps(steps);

  const updateTrace = (status = null) => {
    if (status) db.prepare('UPDATE pipeline_runs SET trace=?, status=? WHERE id=?').run(JSON.stringify(trace), status, runId);
    else db.prepare('UPDATE pipeline_runs SET trace=? WHERE id=?').run(JSON.stringify(trace), runId);
  };

  activeRuns++;
  try {
    throwIfAborted(signal);

    for (let g = 0; g < stepGroups.length; g++) {
      throwIfAborted(signal);
      const group = stepGroups[g];
      const groupPrev = prevOutput;

      for (const idx of group.indices) {
        const step = steps[idx];
        const agent = stepAgent(step);
        const label = step.label || `Step ${idx + 1}`;
        if (!agent) {
          const entry = { step: idx, label, agent_name: step.agent_id, status: 'error', error: 'Agent not found', duration_ms: 0, group: g };
          trace.push(entry);
          updateTrace('error');
          emit?.({ type: 'step_error', ...entry });
          throw new Error(entry.error);
        }
        if (!agent.model) {
          const entry = { step: idx, label, agent_name: agent.name, status: 'error', error: 'No model configured', duration_ms: 0, group: g };
          trace.push(entry);
          updateTrace('error');
          emit?.({ type: 'step_error', ...entry });
          throw new Error(entry.error);
        }
      }

      if (!group.parallel) {
        const idx = group.indices[0];
        const step = steps[idx];
        const agent = stepAgent(step);
        const label = step.label || `Step ${idx + 1}`;
        const prompt = renderStepPrompt(step, cleanInput, groupPrev);
        const toolsOverride = Array.isArray(step.tools) && step.tools.length > 0 ? step.tools : null;

        emit?.({ type: 'step_start', step: idx, label, agent_name: agent.name, group: g });
        const stepStart = Date.now();
        try {
          throwIfAborted(signal);
          const thinkingParts = [];
          const runCtx = { ...(runContext || {}), source: runContext?.source || 'pipeline', onThinking: (t) => thinkingParts.push(t) };
          const output = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, resolvedHivePath, toolsOverride, undefined, signal, runCtx);
          throwIfAborted(signal);
          const entry = { step: idx, label, agent_name: agent.name, status: 'done', output, ...(thinkingParts.length ? { thinking: thinkingParts.join('\n\n') } : {}), duration_ms: Date.now() - stepStart, group: g };
          trace.push(entry);
          updateTrace();
          emit?.({ type: 'step_done', ...entry });
          prevOutput = output;
        } catch (e) {
          const stopped = isAbortError(e, signal);
          const entry = {
            step: idx,
            label,
            agent_name: agent.name,
            status: stopped ? 'stopped' : 'error',
            error: stopped ? 'Pipeline run was stopped' : e.message,
            duration_ms: Date.now() - stepStart,
            group: g,
          };
          trace.push(entry);
          updateTrace(stopped ? 'stopped' : 'error');
          emit?.({ type: stopped ? 'step_stopped' : 'step_error', ...entry });
          throw stopped ? abortError() : e;
        }
      } else {
        for (const idx of group.indices) {
          const step = steps[idx];
          const agent = stepAgent(step);
          const label = step.label || `Step ${idx + 1}`;
          emit?.({ type: 'step_start', step: idx, label, agent_name: agent.name, group: g });
        }

        const results = await Promise.all(group.indices.map(async (idx) => {
          const step = steps[idx];
          const agent = stepAgent(step);
          const label = step.label || `Step ${idx + 1}`;
          const prompt = renderStepPrompt(step, cleanInput, groupPrev);
          const toolsOverride = Array.isArray(step.tools) && step.tools.length > 0 ? step.tools : null;
          const stepStart = Date.now();
          try {
            throwIfAborted(signal);
            const thinkingParts = [];
            const runCtx = { ...(runContext || {}), source: runContext?.source || 'pipeline', onThinking: (t) => thinkingParts.push(t) };
            const output = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, resolvedHivePath, toolsOverride, undefined, signal, runCtx);
            throwIfAborted(signal);
            const entry = { step: idx, label, agent_name: agent.name, status: 'done', output, ...(thinkingParts.length ? { thinking: thinkingParts.join('\n\n') } : {}), duration_ms: Date.now() - stepStart, group: g };
            emit?.({ type: 'step_done', ...entry });
            return entry;
          } catch (e) {
            const stopped = isAbortError(e, signal);
            const entry = {
              step: idx,
              label,
              agent_name: agent.name,
              status: stopped ? 'stopped' : 'error',
              error: stopped ? 'Pipeline run was stopped' : e.message,
              duration_ms: Date.now() - stepStart,
              group: g,
            };
            emit?.({ type: stopped ? 'step_stopped' : 'step_error', ...entry });
            return entry;
          }
        }));

        trace.push(...results);
        updateTrace();
        const stopped = results.find(r => r.status === 'stopped');
        if (stopped || signal?.aborted) {
          updateTrace('stopped');
          throw abortError();
        }
        const failed = results.find(r => r.status === 'error');
        if (failed) {
          db.prepare('UPDATE pipeline_runs SET status=? WHERE id=?').run('error', runId);
          throw new Error(failed.error);
        }
        prevOutput = results.map(r => r.output).join('\n\n---\n\n');
      }
    }

    const total_ms = Date.now() - pipelineStart;
    db.prepare(
      'UPDATE pipeline_runs SET trace=?, final_output=?, total_ms=?, status=? WHERE id=?',
    ).run(JSON.stringify(trace), prevOutput, total_ms, 'done', runId);

    emit?.({ type: 'done', final_output: prevOutput, total_ms });
    return { run_id: runId, final_output: prevOutput, total_ms, trace };
  } catch (e) {
    if (!isAbortError(e, signal)) throw e;
    const total_ms = Date.now() - pipelineStart;
    db.prepare(
      'UPDATE pipeline_runs SET trace=?, total_ms=?, status=? WHERE id=?',
    ).run(JSON.stringify(trace), total_ms, 'stopped', runId);
    emit?.({ type: 'stopped', run_id: runId, total_ms });
    throw abortError();
  } finally {
    activeRuns--;
  }
}

module.exports = { abortError, groupSteps, isAbortError, runPipelineById, renderStepPrompt, activeRunCount };
