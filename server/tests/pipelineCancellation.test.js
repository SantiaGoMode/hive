const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const db = require('../db');
const providers = require('../lib/providers');
const { executeTool } = require('../lib/agentTools');
const { isAbortError, runPipelineById } = require('../lib/pipelineRunner');
const pipelinesRouter = require('../routes/pipelines');

let seq = 0;
let originalStreamChat;

function id(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function createAgent(name) {
  const agentId = id('agent');
  db.prepare(`
    INSERT INTO agents (id, name, model, tools, system_prompt)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, name, 'fake-model', '[]', 'Be brief.');
  return agentId;
}

function createPipeline({ parallel = false } = {}) {
  const firstAgent = createAgent('Cancel A');
  const secondAgent = parallel ? createAgent('Cancel B') : null;
  const pipelineId = id('pipeline');
  const steps = parallel
    ? [
        { agent_id: firstAgent, label: 'A', prompt: '{input}', parallel: true },
        { agent_id: secondAgent, label: 'B', prompt: '{input}', parallel: true },
      ]
    : [
        { agent_id: firstAgent, label: 'Only', prompt: '{input}' },
      ];

  db.prepare('INSERT INTO pipelines (id, name, description, steps) VALUES (?, ?, ?, ?)')
    .run(pipelineId, `Pipeline ${pipelineId}`, '', JSON.stringify(steps));
  return pipelineId;
}

function latestRun(pipelineId) {
  const row = db.prepare('SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY ran_at DESC, id DESC LIMIT 1').get(pipelineId);
  return row ? { ...row, trace: JSON.parse(row.trace || '[]') } : null;
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function installAbortableProvider(expectedStarts) {
  let starts = 0;
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });

  providers.streamChat = async function* streamChat(_model, { signal } = {}) {
    starts += 1;
    if (starts >= expectedStarts) resolveStarted();

    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }

      const timer = setTimeout(resolve, 10_000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });

    yield { type: 'content', delta: 'should not finish' };
    yield { type: 'done', reason: 'stop' };
  };

  return { started, getStarts: () => starts };
}

describe('pipeline cancellation', () => {
  beforeEach(() => {
    originalStreamChat = providers.streamChat;
  });

  afterEach(() => {
    providers.streamChat = originalStreamChat;
  });

  it('marks a cancelled sequential pipeline run as stopped', async () => {
    const pipelineId = createPipeline();
    const ctrl = new AbortController();
    const events = [];
    const provider = installAbortableProvider(1);

    const run = runPipelineById(pipelineId, 'please stop', {
      emit: ev => events.push(ev),
      signal: ctrl.signal,
    });

    await provider.started;
    ctrl.abort();

    await assert.rejects(run, err => isAbortError(err));

    const row = latestRun(pipelineId);
    assert.equal(row.status, 'stopped');
    assert.equal(row.trace.length, 1);
    assert.equal(row.trace[0].status, 'stopped');
    assert.equal(provider.getStarts(), 1);
    assert.ok(events.some(ev => ev.type === 'step_stopped'));
    assert.ok(events.some(ev => ev.type === 'stopped'));
  });

  it('marks all in-flight parallel pipeline steps as stopped on cancellation', async () => {
    const pipelineId = createPipeline({ parallel: true });
    const ctrl = new AbortController();
    const events = [];
    const provider = installAbortableProvider(2);

    const run = runPipelineById(pipelineId, 'please stop both', {
      emit: ev => events.push(ev),
      signal: ctrl.signal,
    });

    await provider.started;
    ctrl.abort();

    await assert.rejects(run, err => isAbortError(err));

    const row = latestRun(pipelineId);
    assert.equal(row.status, 'stopped');
    assert.equal(row.trace.length, 2);
    assert.deepEqual(row.trace.map(entry => entry.status).sort(), ['stopped', 'stopped']);
    assert.equal(provider.getStarts(), 2);
    assert.equal(events.filter(ev => ev.type === 'step_stopped').length, 2);
    assert.ok(events.some(ev => ev.type === 'stopped'));
  });

  it('propagates cancellation through the agent run_pipeline tool', async () => {
    const pipelineId = createPipeline();
    const ctrl = new AbortController();
    const provider = installAbortableProvider(1);

    const run = executeTool(
      'run_pipeline',
      { pipeline_id: pipelineId, input: 'please stop from tool' },
      'caller-agent',
      'http://ollama.test',
      0,
      null,
      null,
      null,
      undefined,
      ctrl.signal,
    );

    await provider.started;
    ctrl.abort();

    await assert.rejects(run, err => err.name === 'AbortError');
  });

  it('aborts the backend pipeline run when the SSE response closes early', async () => {
    const pipelineId = createPipeline();
    const provider = installAbortableProvider(1);
    const app = express();
    app.use(express.json());
    app.use('/api/pipelines', pipelinesRouter);
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/api/pipelines/${pipelineId}/run`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      req.on('error', () => {});
      req.write(JSON.stringify({ input: 'close the stream' }));
      req.end();

      await provider.started;
      req.destroy();

      const row = await waitFor(() => {
        const current = latestRun(pipelineId);
        return current?.status === 'stopped' ? current : null;
      });

      assert.equal(row.status, 'stopped');
      assert.equal(row.trace[0].status, 'stopped');
    } finally {
      await closeServer(server);
    }
  });
});
