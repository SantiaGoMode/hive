// Integration tests for runColony — the actual orchestrator loop.
//
// The fake Ollama server is deliberately scripted to simulate the MISBEHAVIORS
// we have observed in real runs, not just happy-path behavior. Tests that only
// exercise a perfectly-behaved model give false confidence — the guards need to
// be tested against the specific failure modes that actually occur:
//
//   Real-run failure patterns covered here:
//   • Orchestrator hallucinates an agent ID (0x123..., a UUID, a name string)
//   • Orchestrator calls set_plan a second time after work has started
//   • Orchestrator marks a step done without ever calling ask_agent for it
//   • Orchestrator tries to mark in_progress on an already-done step (backtrack)
//   • Orchestrator tries to skip ahead to step 3 before steps 1-2 are started
//   • Worker calls the same tool with identical args 3+ times (install loop)
//   • Orchestrator calls update_plan_step with nonexistent step id
//   • add_plan_step appends a new step mid-run without resetting existing progress
//   • Idempotent update_plan_step returns a helpful warning (not silent success)
//
//   Infrastructure tests (unchanged intent, just here for regression coverage):
//   • Log persistence: entries hit the DB before the run ends
//   • Error handling: Ollama 500 / unreachable → colony status = error
//   • AbortSignal: stop mid-fetch within 1 second
//   • Worker cap: hard-cap at MAX_WORKERS_PER_COLONY
//   • Token streaming: NDJSON chunks produce token events
//   • Preflight: missing model / no tools capability → error
//   • Goal gating: mark_goal_achieved blocked while steps are unfinished
//   • Exit diagnostic: round cap exhausted → error with stall message

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { runColony, createColony, getColony, deleteColony } = require('../lib/colonyRunner');
const db = require('../db');

// ── Fake Ollama server ───────────────────────────────────────────────────────

let fakeOllama;
let fakeOllamaUrl;

function startFakeOllama() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const parsed = body ? JSON.parse(body) : {};
        if (req.url === '/api/tags') {
          if (fakeOllama.tagsHandler) {
            const r = await fakeOllama.tagsHandler();
            res.statusCode = r.status || 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(r.body));
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ models: [{ name: 'fake-model' }, { name: 'fake-model:latest' }] }));
          return;
        }
        if (req.url === '/api/show') {
          if (fakeOllama.showHandler) {
            const r = await fakeOllama.showHandler();
            res.statusCode = r.status || 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(r.body));
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
          return;
        }
        try {
          const result = await fakeOllama.handler(req, parsed);
          if (result === null) return; // hang forever
          res.statusCode = result.status || 200;
          if (Array.isArray(result.stream)) {
            res.setHeader('Content-Type', 'application/x-ndjson');
            for (let i = 0; i < result.stream.length; i++) {
              res.write(JSON.stringify(result.stream[i]) + '\n');
              if (result.chunkDelayMs) await new Promise(r => setTimeout(r, result.chunkDelayMs));
            }
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result.body));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      fakeOllamaUrl = `http://127.0.0.1:${addr.port}`;
      fakeOllama = { server, handler: null };
      resolve();
    });
  });
}

function stopFakeOllama() {
  return new Promise(resolve => fakeOllama.server.close(resolve));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Build the NDJSON stream body a real Ollama chat response produces.
function ollamaToolCall(toolName, toolArgs) {
  return { stream: [{ message: { content: '', tool_calls: [{ function: { name: toolName, arguments: toolArgs } }] }, done: true }] };
}
function ollamaText(content) {
  return { stream: [{ message: { content, tool_calls: [] }, done: true }] };
}

// ── DB setup ──────────────────────────────────────────────────────────────────

const createdColonies = [];
const createdAgents = [];

function cleanup() {
  for (const id of createdColonies) {
    try {
      const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(id);
      if (row) {
        for (const aid of JSON.parse(row.agent_ids || '[]')) createdAgents.push(aid);
      }
      db.prepare('DELETE FROM colonies WHERE id=?').run(id);
    } catch {}
  }
  for (const aid of createdAgents) {
    try { db.prepare('DELETE FROM agents WHERE id=?').run(aid); } catch {}
  }
  createdColonies.length = 0;
  createdAgents.length = 0;
}

let originalOllamaUrl;

before(async () => {
  // Save the real Ollama URL so we can restore it after tests.
  // Without this, running tests overwrites ollama_url with the fake server address
  // and the app can't reach Ollama after the test process exits.
  const row = db.prepare("SELECT value FROM app_settings WHERE key='ollama_url'").get();
  originalOllamaUrl = row?.value || 'http://localhost:11434';

  await startFakeOllama();
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('ollama_url', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(fakeOllamaUrl);
});

after(async () => {
  cleanup();
  await stopFakeOllama();
  // Restore the real Ollama URL so the running app isn't broken after tests.
  db.prepare("UPDATE app_settings SET value=? WHERE key='ollama_url'").run(originalOllamaUrl);
});

beforeEach(cleanup);

// ════════════════════════════════════════════════════════════════════════════
// MISBEHAVIOR GUARDS — these tests simulate what real models actually do wrong
// ════════════════════════════════════════════════════════════════════════════

describe('guard — hallucinated agent ID', () => {
  it('returns "not found" error when orchestrator calls ask_agent with an invented hex ID', async () => {
    // Observed in colony-mns2zuzw: orchestrator called ask_agent with
    // agent_id: "0x123456789abcdef0" — a made-up hex string, not a real ID.
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Do work' }] });
      if (call === 2) return ollamaToolCall('ask_agent', { agent_id: '0x123456789abcdef0', message: 'Do the work' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Hallucinated ID test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    const askResult = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'ask_agent' && e.result?.error,
    );
    assert.ok(askResult, 'ask_agent with hallucinated ID must return an error result');
    assert.match(
      JSON.stringify(askResult.result),
      /not found/i,
      `error should say "not found", got: ${JSON.stringify(askResult.result)}`,
    );
  });

  it('resolves ask_agent by name when orchestrator uses agent name instead of ID', async () => {
    // Observed in colony-mns02ft8: orchestrator called ask_agent with
    // agent_id: "worker_1" (the name it chose) instead of the real ID.
    let call = 0;
    let createdAgentId = null;

    fakeOllama.handler = async (req, parsed) => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Do work' }] });
      if (call === 2) return ollamaToolCall('create_agent', { name: 'my_worker', system_prompt: 'Help', model: 'fake-model' });
      if (call === 3) {
        // Grab the worker ID from the tool result in the messages
        const toolMsg = parsed.messages?.findLast(m => m.role === 'tool');
        if (toolMsg) {
          try { createdAgentId = JSON.parse(toolMsg.content)?.agent_id; } catch {}
        }
        // Simulate model using name instead of ID
        return ollamaToolCall('ask_agent', { agent_id: 'my_worker', message: 'Hello worker' });
      }
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Name resolution test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);

    const askResult = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'ask_agent' && !e.result?.error,
    );
    assert.ok(askResult, 'ask_agent with agent name should resolve to the real agent (not error)');
  });
});

describe('guard — set_plan called twice', () => {
  it('blocks a second set_plan once any step has left pending', async () => {
    // Observed in colony-mns0aiyf (seq 44-46): orchestrator called set_plan again
    // in round 2 after steps were already in progress.
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Step one' }] });
      if (call === 2) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      // Now try to call set_plan again — should be blocked
      if (call === 3) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Replacement plan' }] });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Double set_plan test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    const blocked = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'set_plan' && e.result?.error,
    );
    assert.ok(blocked, 'second set_plan should have been rejected');
    assert.match(
      JSON.stringify(blocked.result),
      /already in progress/i,
      `error should say plan is already in progress, got: ${JSON.stringify(blocked.result)}`,
    );
    // Original plan must still be intact
    assert.equal(colony.plan?.steps?.[0]?.description, 'Step one', 'original plan must not be replaced');
  });
});

describe('guard — marking done without delegation', () => {
  it('returns an error when orchestrator marks a step done without calling ask_agent', async () => {
    // Observed in colony-mns0aiyf (seq 22-23): orchestrator marked step 2 done
    // immediately after setting it in_progress, with no ask_agent call for that step.
    // Guard only fires once workers exist (workersCreated.size > 0).
    // This is a hard error (not a warning) — the step must not be updated.
    let call = 0;
    fakeOllama.handler = async (req, parsed) => {
      const isWorker = parsed.messages?.[0]?.content?.includes('Colony Mission');
      if (isWorker) return ollamaText('Worker ready.');
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Work' }] });
      // Create a worker so the guard activates
      if (call === 2) return ollamaToolCall('create_agent', { name: 'w', system_prompt: 'Help', model: 'fake-model' });
      if (call === 3) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      // Skip ask_agent entirely, go straight to done — guard should fire as hard error
      if (call === 4) return ollamaToolCall('update_plan_step', { id: '1', status: 'done' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Skip delegation test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);
    const blocked = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'update_plan_step' && e.result?.error,
    );
    assert.ok(blocked, 'marking done without ask_agent should be blocked with an error');
    assert.match(
      JSON.stringify(blocked.result),
      /delegated/i,
      `error should mention delegation, got: ${JSON.stringify(blocked.result)}`,
    );
    // Step must still be in_progress (not updated to done)
    assert.equal(colony.plan?.steps?.[0]?.status, 'in_progress', 'step must not be updated to done when guard fires');
  });

  it('blocks marking a pending step done directly (must go through in_progress first)', async () => {
    // Observed in colony-mnrxvbjq (seq 26): orchestrator marked step 2 (still pending)
    // as done directly, skipping in_progress and ask_agent entirely.
    let call = 0;
    fakeOllama.handler = async (req, parsed) => {
      const isWorker = parsed.messages?.[0]?.content?.includes('Colony Mission');
      if (isWorker) return ollamaText('Worker ready.');
      call++;
      if (call === 1) return ollamaToolCall('set_plan', {
        steps: [{ id: '1', description: 'Step one' }, { id: '2', description: 'Step two' }],
      });
      if (call === 2) return ollamaToolCall('create_agent', { name: 'w', system_prompt: 'Help', model: 'fake-model' });
      if (call === 3) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      // Try to mark step 2 done directly while it's still pending
      if (call === 4) return ollamaToolCall('update_plan_step', { id: '2', status: 'done' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Pending to done shortcut test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);
    const blocked = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'update_plan_step' && e.result?.error,
    );
    assert.ok(blocked, 'marking pending step done directly should be blocked');
    assert.match(
      JSON.stringify(blocked.result),
      /pending|in_progress|never started|earlier/i,
      `error should explain the problem, got: ${JSON.stringify(blocked.result)}`,
    );
    // Step 2 must still be pending
    assert.equal(colony.plan?.steps?.[1]?.status, 'pending', 'step 2 must remain pending');
  });
});

describe('guard — step ordering', () => {
  it('blocks marking a step in_progress when an earlier step is still pending', async () => {
    // Observed in colony-mns2zuzw (seq 8-9): orchestrator jumped to step 4
    // in_progress before steps 1-3 had even been started.
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', {
        steps: [
          { id: '1', description: 'First' },
          { id: '2', description: 'Second' },
          { id: '3', description: 'Third' },
        ],
      });
      // Jump straight to step 3 without touching steps 1 or 2
      if (call === 2) return ollamaToolCall('update_plan_step', { id: '3', status: 'in_progress' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Step skip test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    const blocked = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'update_plan_step' && e.result?.error,
    );
    assert.ok(blocked, 'skipping ahead to step 3 with steps 1-2 pending should be blocked');
    assert.match(
      JSON.stringify(blocked.result),
      /hasn.t been started|work through steps in order/i,
      `error should say to work in order, got: ${JSON.stringify(blocked.result)}`,
    );
  });

  it('blocks reopening a completed step (backtrack prevention)', async () => {
    // Model tried to reopen steps 2 and 3 in colony-mns0aiyf (seq 47-50).
    // Must call ask_agent first so delegation guard lets the step reach 'done'.
    let call = 0;
    let workerId = null;
    fakeOllama.handler = async (req, parsed) => {
      const isWorker = parsed.messages?.[0]?.content?.includes('Colony Mission');
      if (isWorker) return ollamaText('Work done.');
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Work' }] });
      if (call === 2) return ollamaToolCall('create_agent', { name: 'w', system_prompt: 'Help', model: 'fake-model' });
      if (call === 3) {
        const toolMsg = parsed.messages?.findLast(m => m.role === 'tool');
        try { workerId = JSON.parse(toolMsg?.content)?.agent_id; } catch {}
        return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      }
      if (call === 4) return ollamaToolCall('ask_agent', { agent_id: workerId || 'w', message: 'Do it' });
      if (call === 5) return ollamaToolCall('update_plan_step', { id: '1', status: 'done' });
      // Now try to reopen it
      if (call === 6) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Backtrack prevention test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);
    const blocked = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'update_plan_step' && e.result?.error,
    );
    assert.ok(blocked, 'reopening a done step should be blocked');
    assert.match(
      JSON.stringify(blocked.result),
      /already done/i,
      `error should say step is already done, got: ${JSON.stringify(blocked.result)}`,
    );
  });

  it('returns an idempotency warning when update_plan_step is called with the same status', async () => {
    // Observed in colony-mns02ft8: update_plan_step called 14 times with id=1, status=in_progress.
    // Each call must return a warning (not silent success) so the model knows to move on.
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Work' }] });
      if (call === 2) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      // Repeat the same call — should warn, not silently succeed
      if (call === 3) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Idempotent update test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    const warned = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'update_plan_step' && e.result?.warning,
    );
    assert.ok(warned, 'repeated in_progress update should return a warning');
    assert.match(
      JSON.stringify(warned.result),
      /already in_progress|already/i,
      `warning should say step is already in that state, got: ${JSON.stringify(warned.result)}`,
    );
  });
});

describe('guard — worker tool loop detection', () => {
  it('breaks the loop when a worker calls the same tool with identical args 3+ times', async () => {
    // Observed in colony-mns0aiyf: MetricsDeveloper called install_package("virtualenv")
    // 20 times because it couldn't distinguish a pip WARNING from a failure.
    // After 3 identical consecutive calls, the guard must inject a stop-retrying error.
    let orchCall = 0;
    let workerCallCount = 0;

    fakeOllama.handler = async (req, parsed) => {
      // Identify caller by presence of a system prompt matching worker vs orchestrator
      const isWorkerCall = parsed.messages?.[0]?.content?.includes('Colony Mission');

      if (isWorkerCall) {
        workerCallCount++;
        // Worker: always try to install the same package (simulates the loop)
        if (workerCallCount <= 5) {
          return ollamaToolCall('install_package', { package: 'virtualenv' });
        }
        return ollamaText('Done.');
      }

      // Orchestrator
      orchCall++;
      if (orchCall === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Install deps' }] });
      if (orchCall === 2) return ollamaToolCall('create_agent', { name: 'worker', system_prompt: 'Install stuff', model: 'fake-model' });
      if (orchCall === 3) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      if (orchCall === 4) {
        // Get the worker's ID from last tool result
        const toolMsg = parsed.messages?.findLast(m => m.role === 'tool');
        let wid;
        try { wid = JSON.parse(toolMsg?.content)?.agent_id; } catch {}
        return ollamaToolCall('ask_agent', { agent_id: wid || 'worker', message: 'Install virtualenv' });
      }
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Worker loop detection test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);

    // The loop-detection error must appear in the log
    const loopError = colony.log.find(e =>
      e.kind === 'tool_result' &&
      e.tool === 'install_package' &&
      e.result?.error &&
      /duplicate call|identical/i.test(JSON.stringify(e.result)),
    );
    assert.ok(loopError, 'should have a loop-detection error for repeated install_package calls');
  });
});

describe('guard — add_plan_step', () => {
  it('appends a new step mid-run without resetting existing plan progress', async () => {
    // Observed in colony-mns2zuzw: all 4 steps were done but orchestrator wanted
    // to add a 5th. It looped on set_plan (blocked) instead. add_plan_step is the
    // correct escape hatch — verify it appends without disturbing done steps.
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Initial work' }] });
      if (call === 2) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      // Add a new step mid-run
      if (call === 3) return ollamaToolCall('add_plan_step', { description: 'Extra step discovered mid-run' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('add_plan_step test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    assert.ok(colony.plan, 'plan should exist');
    assert.equal(colony.plan.steps.length, 2, 'plan should have 2 steps after add_plan_step');
    assert.equal(colony.plan.steps[1].description, 'Extra step discovered mid-run');
    // Original step must still be in_progress (not reset)
    assert.equal(colony.plan.steps[0].status, 'in_progress', 'add_plan_step must not reset existing step status');
  });

  it('rejects add_plan_step when no plan exists yet', async () => {
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('add_plan_step', { description: 'No plan yet' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('add_plan_step no-plan test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    const errResult = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'add_plan_step' && e.result?.error,
    );
    assert.ok(errResult, 'add_plan_step without a plan should return an error');
  });
});

describe('guard — researcher web_search auto-injection', () => {
  it('auto-adds web_search when orchestrator creates a Researcher without it', async () => {
    // Observed in colony-mnrxvbjq (seq 8): orchestrator created "Researcher" with only
    // tools: ["memory"]. Server should auto-inject web_search so the researcher can
    // find real information instead of hallucinating from memory.
    let call = 0;
    fakeOllama.handler = async (req, parsed) => {
      const isWorker = parsed.messages?.[0]?.content?.includes('Colony Mission');
      if (isWorker) return ollamaText('Research done.');
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Research topic' }] });
      // Create researcher WITHOUT web_search — server should add it automatically
      if (call === 2) return ollamaToolCall('create_agent', {
        name: 'Researcher',
        system_prompt: 'You are a research assistant.',
        model: 'fake-model',
        tools: ['memory'],
      });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Researcher web_search injection test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);

    const createResult = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'create_agent' && e.result?.success,
    );
    assert.ok(createResult, 'researcher should be created successfully');
    const agentTools = createResult.result?.agent?.tools || [];
    assert.ok(
      agentTools.includes('web_search'),
      `Researcher agent should have web_search auto-injected, got: ${JSON.stringify(agentTools)}`,
    );
  });

  it('does not add web_search to a non-research worker (Implementer)', async () => {
    let call = 0;
    fakeOllama.handler = async (req, parsed) => {
      const isWorker = parsed.messages?.[0]?.content?.includes('Colony Mission');
      if (isWorker) return ollamaText('Implementation done.');
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Build something' }] });
      if (call === 2) return ollamaToolCall('create_agent', {
        name: 'Implementer',
        system_prompt: 'You write code and build things.',
        model: 'fake-model',
        tools: ['sandbox'],
      });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Implementer no web_search test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);

    const createResult = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'create_agent' && e.result?.success,
    );
    assert.ok(createResult, 'implementer should be created successfully');
    const agentTools = createResult.result?.agent?.tools || [];
    assert.ok(
      !agentTools.includes('web_search'),
      `Implementer should NOT get web_search auto-injected, got: ${JSON.stringify(agentTools)}`,
    );
  });
});

describe('guard — duplicate agent names', () => {
  it('rejects creating an agent with a name already used in the colony', async () => {
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Work' }] });
      if (call === 2) return ollamaToolCall('create_agent', { name: 'worker_1', model: 'fake-model', system_prompt: 'Help' });
      // Try to create another agent with the same name
      if (call === 3) return ollamaToolCall('create_agent', { name: 'worker_1', model: 'fake-model', system_prompt: 'Also help' });
      return ollamaText('GOAL ACHIEVED: done.');
    };

    const id = createColony('Duplicate name test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);

    const dupError = colony.log.find(e =>
      e.kind === 'tool_result' && e.tool === 'create_agent' && e.result?.error,
    );
    assert.ok(dupError, 'duplicate agent name should be rejected');
    assert.match(
      JSON.stringify(dupError.result),
      /already exists/i,
      `error should say agent name already exists, got: ${JSON.stringify(dupError.result)}`,
    );
    // Only one worker should exist (the first)
    const workers = colony.agent_ids.filter(id => id !== colony.orchestrator_id);
    assert.equal(workers.length, 1, 'only one worker should be created despite two create_agent calls');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE TESTS — basic plumbing regression coverage
// ════════════════════════════════════════════════════════════════════════════

describe('runColony — log persistence', () => {
  it('persists log entries to the DB immediately (survives a refresh)', async () => {
    fakeOllama.handler = async () => ollamaText('GOAL ACHIEVED: Done.');

    const id = createColony('Test goal — persistence', 'fake-model', 'custom_auto');
    createdColonies.push(id);

    await runColony(id, () => {}, null);

    const colony = getColony(id);
    assert.equal(colony.status, 'done');
    assert.ok(colony.log.length >= 2);
    assert.ok(colony.log.some(e => e.kind === 'agent_ready' && e.role === 'orchestrator'));
    assert.ok(colony.log.some(e => e.kind === 'done'));
  });

  it('persists the agent_ready entry even when the run is aborted right after', async () => {
    fakeOllama.handler = async () => null; // hang

    const id = createColony('Test goal — early abort', 'fake-model', 'custom_auto');
    createdColonies.push(id);

    const ac = new AbortController();
    const runPromise = runColony(id, () => {}, ac.signal);
    await new Promise(r => setTimeout(r, 200));

    const midColony = getColony(id);
    assert.ok(midColony.log.length >= 1, `log should have agent_ready already (got ${midColony.log.length})`);

    ac.abort();
    await runPromise;

    assert.equal(getColony(id).status, 'stopped');
  });
});

describe('runColony — error handling', () => {
  it('updates status to error when Ollama returns an HTTP error', async () => {
    fakeOllama.handler = async () => ({ status: 500, body: { error: 'boom' } });

    const id = createColony('Test goal — ollama 500', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    assert.equal(colony.status, 'error');
    assert.ok(colony.log.some(e => e.kind === 'error'));
  });

  it('updates status to error and does not stay stuck at running when Ollama is unreachable', async () => {
    const badUrl = 'http://127.0.0.1:1';
    db.prepare("UPDATE app_settings SET value=? WHERE key='ollama_url'").run(badUrl);

    const id = createColony('Test goal — ollama unreachable', 'fake-model', 'custom_auto');
    createdColonies.push(id);

    try {
      await runColony(id, () => {}, null);
    } finally {
      db.prepare("UPDATE app_settings SET value=? WHERE key='ollama_url'").run(fakeOllamaUrl);
    }

    const colony = getColony(id);
    assert.notEqual(colony.status, 'running');
    assert.equal(colony.status, 'error');
  });
});

describe('runColony — worker agent tracking', () => {
  it('adds workers to colony.agent_ids when orchestrator calls create_agent', async () => {
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('create_agent', { name: 'worker-one', system_prompt: 'You help.', tools: [], model: 'fake-model' });
      return ollamaText('GOAL ACHIEVED: worker created.');
    };

    const id = createColony('Test goal — worker tracking', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    assert.equal(colony.status, 'done');
    assert.ok(colony.agent_ids.length >= 2, `expected orchestrator + worker (got ${colony.agent_ids.length})`);
    for (const aid of colony.agent_ids) createdAgents.push(aid);
  });
});

describe('runColony — signal / stop', () => {
  it('aborts an in-flight Ollama fetch within ~1 second when signal is aborted', async () => {
    fakeOllama.handler = async () => null; // hang

    const id = createColony('Test goal — abort mid-fetch', 'fake-model', 'custom_auto');
    createdColonies.push(id);

    const ac = new AbortController();
    const start = Date.now();
    const runPromise = runColony(id, () => {}, ac.signal);
    setTimeout(() => ac.abort(), 150);
    await runPromise;

    assert.ok(Date.now() - start < 3000);
    assert.equal(getColony(id).status, 'stopped');
  });

  it('stopColonyRun aborts a run launched with no external signal (trigger path)', async () => {
    const { stopColonyRun, isColonyRunning } = require('../lib/colonyRunner');
    fakeOllama.handler = async () => null; // hang

    const id = createColony('Test goal — stopColonyRun', 'fake-model', 'custom_auto');
    createdColonies.push(id);

    const runPromise = runColony(id, () => {}, null); // no signal, like colonyTriggers
    await new Promise(r => setTimeout(r, 150));

    assert.equal(isColonyRunning(id), true);
    assert.equal(stopColonyRun(id), true);
    await runPromise;

    assert.equal(getColony(id).status, 'stopped');
    assert.equal(isColonyRunning(id), false);
    assert.equal(stopColonyRun(id), false, 'finished run should no longer be stoppable');
  });
});

describe('runColony — worker cap', () => {
  it('rejects create_agent once per-colony worker cap (3) is reached', async () => {
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call <= 5) {
        return ollamaToolCall('create_agent', {
          name: `worker-${call}`, system_prompt: 'Help.', tools: [], model: 'fake-model',
        });
      }
      return ollamaText('GOAL ACHIEVED: enough.');
    };

    const id = createColony('Test goal — worker cap', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    for (const aid of colony.agent_ids) createdAgents.push(aid);

    // Orchestrator + max 3 workers = 4 total
    assert.ok(colony.agent_ids.length <= 4, `expected <= 4 agent ids (orchestrator + 3 workers), got ${colony.agent_ids.length}`);
    const capHit = colony.log.some(e =>
      e.kind === 'tool_result' && e.tool === 'create_agent' && /Worker cap reached/.test(JSON.stringify(e.result || '')),
    );
    assert.ok(capHit, 'at least one create_agent must have been rejected with Worker cap message');
  });
});

describe('runColony — token streaming', () => {
  it('emits token events as NDJSON chunks arrive from Ollama', async () => {
    fakeOllama.handler = async () => ({
      stream: [
        { message: { content: 'GOAL ' }, done: false },
        { message: { content: 'ACHIEVED: ' }, done: false },
        { message: { content: 'hello' }, done: false },
        { message: { content: '', tool_calls: [] }, done: true },
      ],
    });

    const id = createColony('Test goal — token streaming', 'fake-model', 'custom_auto');
    createdColonies.push(id);

    const events = [];
    await runColony(id, e => events.push(e), null);

    const tokenEvents = events.filter(e => e.type === 'token');
    assert.ok(tokenEvents.length >= 3, `expected >= 3 token events, got ${tokenEvents.length}`);
    assert.ok(tokenEvents.map(t => t.delta).join('').includes('GOAL ACHIEVED: hello'));
    assert.equal(getColony(id).status, 'done');
  });
});

describe('runColony — preflight', () => {
  it('rejects when the selected model is not installed', async () => {
    fakeOllama.tagsHandler = async () => ({ body: { models: [{ name: 'some-other-model' }] } });
    fakeOllama.handler = async () => ollamaText('irrelevant');

    const id = createColony('Preflight missing model test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);
    fakeOllama.tagsHandler = null;

    const colony = getColony(id);
    assert.equal(colony.status, 'error');
    assert.match(colony.log.find(e => e.kind === 'error').message, /not installed/i);
  });

  it('rejects when the selected model has no tools capability', async () => {
    fakeOllama.showHandler = async () => ({ body: { capabilities: ['completion'] } });
    fakeOllama.handler = async () => ollamaText('irrelevant');

    const id = createColony('Preflight no-tools test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);
    fakeOllama.showHandler = null;

    const colony = getColony(id);
    assert.equal(colony.status, 'error');
    assert.match(colony.log.find(e => e.kind === 'error').message, /does not support tool calling/i);
  });
});

describe('runColony — recipes', () => {
  it('runs Research Mission as a seeded crew with model-driven planning', async () => {
    let operatorCalls = 0;
    const crewIds = {};
    fakeOllama.handler = async (_req, parsed) => {
      const system = parsed.messages?.[0]?.content || '';
      if (system.includes('Research Mission Operator')) {
        operatorCalls++;
        if (!crewIds.researcher) {
          crewIds.researcher = system.match(/Researcher\) [^"]*-> agent_id: "([^"]+)"/)?.[1];
          crewIds.critic = system.match(/Source Critic\) [^"]*-> agent_id: "([^"]+)"/)?.[1];
          crewIds.synthesizer = system.match(/Synthesizer\) [^"]*-> agent_id: "([^"]+)"/)?.[1];
        }
        if (operatorCalls === 1) {
          return ollamaToolCall('set_plan', {
            steps: [
              { id: '1', description: 'Gather source-backed research', assigned_to: crewIds.researcher },
              { id: '2', description: 'Review evidence quality and caveats', assigned_to: crewIds.critic },
              { id: '3', description: 'Synthesize the final research brief', assigned_to: crewIds.synthesizer },
            ],
          });
        }
        if (operatorCalls === 2) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
        if (operatorCalls === 3) return ollamaToolCall('ask_agent', { agent_id: crewIds.researcher, message: 'Gather source-backed research.' });
        if (operatorCalls === 4) return ollamaToolCall('update_plan_step', { id: '1', status: 'done' });
        if (operatorCalls === 5) return ollamaToolCall('update_plan_step', { id: '2', status: 'in_progress' });
        if (operatorCalls === 6) return ollamaToolCall('ask_agent', { agent_id: crewIds.critic, message: 'Review the research handoff.', context: 'Research handoff: findings and sources.' });
        if (operatorCalls === 7) return ollamaToolCall('update_plan_step', { id: '2', status: 'done' });
        if (operatorCalls === 8) return ollamaToolCall('update_plan_step', { id: '3', status: 'in_progress' });
        if (operatorCalls === 9) return ollamaToolCall('ask_agent', { agent_id: crewIds.synthesizer, message: 'Synthesize the final brief.', context: 'Research handoff plus critic handoff.' });
        if (operatorCalls === 10) return ollamaToolCall('update_plan_step', { id: '3', status: 'done' });
        return ollamaToolCall('mark_goal_achieved', { summary: 'Research mission complete.' });
      }
      if (system.includes('You are Researcher')) return ollamaText('Research handoff: findings and sources.');
      if (system.includes('You are Source Critic')) return ollamaText('Critic handoff: evidence is medium strength.');
      if (system.includes('You are Synthesizer')) return ollamaText('Final brief: concise synthesized deliverable.');
      return ollamaText('unexpected request');
    };

    const id = createColony('Recipe roster test', 'fake-model', 'research_brief');
    createdColonies.push(id);

    await runColony(id, () => {}, null);

    const colony = getColony(id);
    const errorEntry = colony.log.find(e => e.kind === 'error');
    if (colony.status !== 'done') {
      assert.fail(`error=${errorEntry?.message || '(none)'} log=${JSON.stringify(colony.log.slice(-8))}`);
    }
    assert.equal(colony.recipe_id, 'research_brief');
    assert.ok(colony.log.some(e => e.kind === 'recipe' && e.recipe_id === 'research_brief'));

    const roles = colony.agents.map(a => a.persona_role);
    assert.ok(roles.includes('Researcher'));
    assert.ok(roles.includes('Source Critic'));
    assert.ok(roles.includes('Synthesizer'));
    assert.ok(roles.includes('Research Mission Operator'));

    assert.ok(operatorCalls > 0, 'recipe operator should call Ollama to decide the mission plan');
    assert.equal(colony.summary, 'Research mission complete.');
    assert.ok(colony.plan?.steps?.every(s => s.status === 'done'));
    assert.equal(colony.log.filter(e => e.kind === 'tool_call' && e.tool === 'ask_agent').length, 3);
    assert.equal(colony.log.filter(e => e.kind === 'tool_call' && e.tool === 'create_agent').length, 0);
  });
});

describe('runColony — plan tools and goal gating', () => {
  it('persists set_plan / update_plan_step and emits plan_update events', async () => {
    // Steps must go through in_progress before done (pending→done is now blocked).
    // No workers are created so delegation guard doesn't fire.
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'First step' }, { id: '2', description: 'Second step' }] });
      if (call === 2) return ollamaToolCall('update_plan_step', { id: '1', status: 'in_progress' });
      if (call === 3) return ollamaToolCall('update_plan_step', { id: '1', status: 'done' });
      if (call === 4) return ollamaToolCall('update_plan_step', { id: '2', status: 'in_progress' });
      if (call === 5) return ollamaToolCall('update_plan_step', { id: '2', status: 'done' });
      return ollamaToolCall('mark_goal_achieved', { summary: 'All steps verified and complete.' });
    };

    const id = createColony('Plan tools test', 'fake-model', 'custom_auto');
    createdColonies.push(id);

    const events = [];
    await runColony(id, e => events.push(e), null);

    const colony = getColony(id);
    assert.equal(colony.status, 'done');
    assert.ok(colony.plan?.steps?.every(s => s.status === 'done'));
    assert.equal(colony.summary, 'All steps verified and complete.');
    assert.ok(events.filter(e => e.type === 'plan_update').length >= 3);
  });

  it('mark_goal_achieved is refused when plan steps are unfinished', async () => {
    let call = 0;
    fakeOllama.handler = async () => {
      call++;
      if (call === 1) return ollamaToolCall('set_plan', { steps: [{ id: '1', description: 'Unfinished work' }] });
      return ollamaToolCall('mark_goal_achieved', { summary: 'Pretending to be done.' });
    };

    const id = createColony('Plan gating test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    assert.equal(colony.status, 'error');
    assert.notEqual(colony.summary, 'Pretending to be done.');
    assert.ok(colony.log.some(e =>
      e.kind === 'tool_result' && e.tool === 'mark_goal_achieved' && /Cannot mark goal achieved/.test(JSON.stringify(e.result || '')),
    ));
  });
});

describe('runColony — exit diagnostic', () => {
  it('marks colony as error with a stall diagnostic when no completion happens within round cap', async () => {
    fakeOllama.handler = async () => ollamaText('thinking about it…');

    const id = createColony('Stall diagnostic test', 'fake-model', 'custom_auto');
    createdColonies.push(id);
    await runColony(id, () => {}, null);

    const colony = getColony(id);
    assert.equal(colony.status, 'error');
    assert.match(colony.log.find(e => e.kind === 'error').message, /did not call mark_goal_achieved|stalled/i);
  });
});
