const { writeAgent, readAgent, stripProviderPrefix } = require('./agentParser');
const { runAgentOnce } = require('./agentTools');
const { publish, maybeCleanup } = require('./colonyBus');
const db = require('../db');

// Keep the last N entries in the single `colonies.log` TEXT field. Long runs
// trim oldest entries — by seq number, so clients can still tell if they
// missed anything. Previously there was a LOG_MAX_BYTES hard cap that silently
// dropped writes above 200KB; that was a footgun because the UI would just
// stop updating from the DB mid-run with no error.
const LOG_MAX_ENTRIES = 1000;
// Safety caps — prevent runaway resource use.
// MAX_WORKERS_PER_COLONY: hard cap on agents the orchestrator can spawn.
//   The orchestrator prompt already suggests 2–4, but a buggy model can loop
//   on create_agent without this cap. Does NOT count the orchestrator itself.
const MAX_WORKERS_PER_COLONY = 3;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getOllamaUrl() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='ollama_url'").get();
  return row?.value || 'http://localhost:11434';
}

function orchestratorPrompt(goal, model) {
  return `You are an AI Colony Orchestrator. You lead a team of specialized workers to complete a mission.

MISSION: ${goal}

## Your tools
- set_plan: define the step-by-step plan (call FIRST, only once)
- add_plan_step: append a new step mid-run if extra work is discovered
- update_plan_step: mark a step in_progress, done, or blocked
- mark_goal_achieved: call once every step is done to end the run
- create_agent: spawn a worker with a specific role
- ask_agent: delegate a task to a worker — always use the agent_id from create_agent

## Workflow
1. Call set_plan with 3–5 concrete steps. This is your FIRST tool call — no text before it.
2. Create 2–3 SPECIALIZED workers upfront, one per role. Each worker should be distinct:
   - A Researcher or Analyst: searches the web, finds real information (tools: ["web_search"])
   - An Implementer or Builder: writes files, runs code (tools: ["sandbox"])
   - A Reviewer or Writer: assembles findings into polished documents (tools: ["sandbox"])
3. For each step IN ORDER:
   a. update_plan_step → in_progress
   b. ask_agent with the worker BEST SUITED for that step's role:
      - Research/information gathering → Researcher (web_search)
      - Writing files, running code → Implementer or Builder (sandbox)
      - Reviewing, assembling final output → Reviewer or Writer (sandbox)
   c. Verify the response has real content (not "(no response)") — retry if empty
   d. update_plan_step → done ONLY after the worker returns actual output
4. Call mark_goal_achieved with a 2–4 sentence summary once all steps are done.

## Hard rules
- set_plan is ALWAYS first. No exceptions.
- Create AT LEAST 2 workers — a colony with one worker is not a colony.
- Each worker must have a DIFFERENT role and name. Do not create two "Researcher" agents.
- Do NOT give workers colony management tools (set_plan, update_plan_step, mark_goal_achieved) — those are yours only.
- Researchers MUST have tools: ["web_search"] so they can find real information, not just generate from memory.
- Only give tools: ["sandbox"] to workers that need to write files or run code.
- Do NOT leave a researcher's tools empty — without web_search they can only hallucinate facts.
- NEVER mark a step done if the worker returned "(no response)". Retry with simpler instructions.
- Use the agent_id (hex string from create_agent), not the name, in every ask_agent call.
- Max 3 workers. Reuse them across steps — a researcher can be asked multiple questions.
- USE EACH WORKER for its intended role. Do not delegate all steps to one worker.
- EVERY step must pass through: in_progress → ask_agent → done. Skipping any stage is an error.
- Steps must be completed in order. You cannot mark step N done while step N-1 is in_progress.

## Worker model: ${model}
## Sandbox (for workers with tools: ["sandbox"])
Python 3.11 (flask, numpy, pandas, requests, pytest), Node.js 20, git, curl, sqlite3.
Write files with write_file. Run code with run_python or run_bash. Ports 3000/5000/8000/8080 forwarded.
Do NOT install Jenkins, Docker, databases — unavailable.`;
}

// ── Pre-flight ───────────────────────────────────────────────────────────────
// Fail fast with a clear message if the selected model is missing or doesn't
// support tool calling. Previously the colony would silently produce garbage
// when the user picked a non-tool-capable model.
async function preflightColony(model, ollamaUrl) {
  const stripped = stripProviderPrefix(model);

  // 1. Ollama reachable?
  let tagsRes;
  try {
    tagsRes = await fetch(`${ollamaUrl}/api/tags`);
  } catch (e) {
    const code = e.cause?.code;
    if (code === 'ECONNREFUSED') {
      return { ok: false, error: `Cannot reach Ollama at ${ollamaUrl}. Start Ollama with "ollama serve" and try again.` };
    }
    return { ok: false, error: `Cannot reach Ollama at ${ollamaUrl}: ${e.message}` };
  }
  if (!tagsRes.ok) return { ok: false, error: `Ollama returned HTTP ${tagsRes.status} from /api/tags` };
  const tags = await tagsRes.json();

  // 2. Model installed?
  const models = Array.isArray(tags.models) ? tags.models : [];
  const found = models.some(m => m.name === stripped || m.name === `${stripped}:latest` || m.name.startsWith(`${stripped}:`));
  if (!found) {
    const available = models.map(m => m.name).slice(0, 8).join(', ') || '(none)';
    return {
      ok: false,
      error: `Model "${stripped}" is not installed on Ollama. Pull it with "ollama pull ${stripped}". Currently installed: ${available}`,
    };
  }

  // 3. Tool-calling capability. Many popular models (vanilla llama3, gemma) don't
  // support tools and the orchestrator needs tool calls to function at all. Older
  // Ollama versions may not return a capabilities array — in that case we skip
  // the check rather than false-reject.
  try {
    const showRes = await fetch(`${ollamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: stripped }),
    });
    if (showRes.ok) {
      const info = await showRes.json();
      const caps = Array.isArray(info.capabilities) ? info.capabilities : null;
      if (caps && caps.length > 0 && !caps.includes('tools')) {
        return {
          ok: false,
          error: `Model "${stripped}" does not support tool calling (capabilities: ${caps.join(', ')}). Colony requires a tool-capable model — try llama3.1, qwen2.5, qwen3, mistral-nemo, or mistral-small.`,
        };
      }
    }
  } catch {
    // Non-fatal — skip capability check if /api/show misbehaves.
  }

  return { ok: true };
}

function makeFakeWs(onEvent) {
  return {
    OPEN: 1,
    readyState: 1,
    send(raw) {
      try { onEvent(JSON.parse(raw)); } catch {}
    },
  };
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

async function runColony(colonyId, onEventArg, signal) {
  const logEntries = [];
  let logDirty = false;
  let seqCounter = 0;

  // Every event goes to: (a) the per-colony event bus for resumable SSE,
  // (b) the legacy onEvent callback if supplied (used by tests and the old
  // direct-streaming path). Either can be absent.
  const onEvent = (event) => {
    try { publish(colonyId, event); } catch {}
    if (onEventArg) {
      try { onEventArg(event); } catch {}
    }
  };

  // Persist log to DB immediately on every entry — avoids data loss on refresh/crash.
  const flush = () => {
    if (!logDirty) return;
    try {
      persistLog(colonyId, logEntries.slice(-LOG_MAX_ENTRIES));
    } catch {}
    logDirty = false;
  };

  const addEntry = (entry) => {
    const e = { ...entry, ts: Date.now(), seq: ++seqCounter };
    logEntries.push(e);
    logDirty = true;
    onEvent({ type: 'log_entry', entry: e });
    flush();
  };

  // Captured goal-achievement signal from the mark_goal_achieved tool.
  let goalSummary = null;

  try {
    const row = db.prepare('SELECT * FROM colonies WHERE id=?').get(colonyId);
    if (!row) throw new Error(`Colony ${colonyId} not found`);

    const ollamaUrl = getOllamaUrl();

    // ── Pre-flight: fail fast with a clear error before spawning anything ────
    addEntry({ kind: 'preflight', message: `Checking model "${stripProviderPrefix(row.model)}" on Ollama…` });
    const preflight = await preflightColony(row.model, ollamaUrl);
    if (!preflight.ok) {
      throw new Error(preflight.error);
    }
    addEntry({ kind: 'preflight', message: 'Model ready — tool calling supported.' });

    // Soft warning for models known to describe tool calls in text instead of
    // invoking them properly. The text parser in agentTools.js will compensate,
    // but results may be less reliable than with a tool-native model.
    const weakToolModels = /^llama3(\.|:)|^llama-3(\.|:)|^mistral(?!-nemo|-small)/i;
    if (weakToolModels.test(stripProviderPrefix(row.model))) {
      addEntry({
        kind: 'preflight',
        message: `⚠ ${stripProviderPrefix(row.model)} has limited multi-step tool-calling reliability. Colony will attempt a text-based tool call fallback, but for best results use qwen2.5, qwen3, or mistral-nemo.`,
      });
    }

    // ── Create orchestrator ───────────────────────────────────────────────────
    // Give orchestrator the colony_tools group so it can call set_plan,
    // update_plan_step, and mark_goal_achieved. Workers do NOT get this group.
    const orch = writeAgent(null, {
      name:         `orch-${colonyId.slice(0, 6)}`,
      persona_role: 'Colony Orchestrator',
      model:        row.model,
      avatar_color: '#f59e0b',
      tools:        ['colony_tools', 'agent_tools', 'sandbox', 'memory'],
      system_prompt: orchestratorPrompt(row.goal, row.model),
      temperature:  0.4,
      max_tokens:   8192,
      context_length: 32768,
    });

    db.prepare('UPDATE colonies SET orchestrator_id=?, updated_at=unixepoch() WHERE id=?')
      .run(orch.id, colonyId);
    addAgentToColony(colonyId, orch.id);

    const orchAgent = { id: orch.id, name: orch.name, persona_role: orch.persona_role, avatar_color: orch.avatar_color };
    onEvent({ type: 'agent_ready', role: 'orchestrator', agent: orchAgent });
    addEntry({ kind: 'agent_ready', role: 'orchestrator', agent: orchAgent });

    // ── Wire up live event stream ─────────────────────────────────────────────
    const fakeWs = makeFakeWs((msg) => {
      if (signal?.aborted) return;

      // Track new agents created by orchestrator. runAgentOnce emits every tool
      // call from inside its loop as 'sub_tool_call'/'sub_tool_result', so we
      // must match both forms here.
      const isToolResult = msg.type === 'tool_result' || msg.type === 'sub_tool_result';
      if (isToolResult && msg.name === 'create_agent' && msg.result?.agent_id) {
        addAgentToColony(colonyId, msg.result.agent_id);
        const newAgent = readAgent(msg.result.agent_id);
        if (newAgent) {
          const wa = { id: newAgent.id, name: newAgent.name, persona_role: newAgent.persona_role, avatar_color: newAgent.avatar_color };
          onEvent({ type: 'agent_ready', role: 'worker', agent: wa });
          addEntry({ kind: 'agent_ready', role: 'worker', agent: wa });
        }
      }

      // Emit structured log entries for interesting tool calls
      const agentLabel = msg.subAgent || 'Orchestrator';

      // Token deltas stream through the bus directly — NOT persisted to the
      // DB log (would explode it) and NOT wrapped in a {type:'ws'} envelope
      // so the client can handle them with a dedicated case.
      if (msg.type === 'token') {
        onEvent({ type: 'token', agent: agentLabel, kind: msg.kind, delta: msg.delta });
        return;
      }

      if (msg.type === 'tool_call' || msg.type === 'sub_tool_call') {
        addEntry({
          kind:  'tool_call',
          agent: agentLabel,
          tool:  msg.name,
          args:  truncateArgs(msg.args),
        });
      }

      if (msg.type === 'tool_result' || msg.type === 'sub_tool_result') {
        addEntry({
          kind:   'tool_result',
          agent:  agentLabel,
          tool:   msg.name,
          result: truncateResult(msg.result),
        });

        // Capture plan state updates and goal-achievement signals. These come
        // from the three colony_tools and must drive: (a) a dedicated
        // plan_update bus event so the UI can rerender the checklist, and
        // (b) goalSummary so the outer loop exits cleanly on completion.
        if (msg.name === 'set_plan' && msg.result?.success && msg.result?.steps) {
          onEvent({ type: 'plan_update', plan: { steps: msg.result.steps } });
          addEntry({ kind: 'plan_set', step_count: msg.result.steps.length });
        }
        if (msg.name === 'update_plan_step' && msg.result?.success && msg.result?.plan) {
          onEvent({ type: 'plan_update', plan: msg.result.plan });
          addEntry({
            kind: 'plan_step_update',
            step_id: msg.result.step?.id,
            status: msg.result.step?.status,
            description: msg.result.step?.description,
          });
        }
        if (msg.name === 'mark_goal_achieved' && msg.result?.goal_achieved && msg.result?.summary) {
          goalSummary = msg.result.summary;
        }
      }

      // Forward raw WS event for live clients
      onEvent({ type: 'ws', msg });
    });

    // ── Orchestrator run loop ─────────────────────────────────────────────────
    const messages = [{
      role: 'user',
      content: 'Call set_plan now with 3–6 steps to accomplish the mission. This must be your first tool call — do not write any text first.',
    }];

    // Persistent conversation history for workers — keyed by agent_id.
    // Passed into colonyContext so ask_agent can give each worker a continuous
    // thread across multiple delegation calls instead of starting fresh each time.
    const agentHistories = new Map();
    // Tracks which plan step IDs have had at least one ask_agent call.
    // Prevents the orchestrator from marking steps done without any real delegation.
    const delegatedSteps = new Set();
    // Tracks IDs of workers that have been successfully created.
    // Delegation guard only activates once at least one worker exists.
    const workersCreated = new Set();

    // Outer review loop: runAgentOnce does one "turn" with up to 20 tool-call
    // rounds internally. Between turns we check for completion and, if not
    // done, inject a state-aware nudge showing the current plan status.
    const MAX_OUTER_ROUNDS = 6;
    let completed = false;

    for (let outer = 0; outer < MAX_OUTER_ROUNDS; outer++) {
      if (signal?.aborted) break;

      addEntry({ kind: 'round', round: outer + 1 });
      onEvent({ type: 'round_start', round: outer + 1 });

      const response = await runAgentOnce(
        orch, messages, ollamaUrl,
        0,      // depth
        fakeWs,
        null,   // hivePath
        null,   // toolsOverride
        20,     // maxRounds — cascades to workers via executeTool → ask_agent
        signal, // AbortSignal — cancels in-flight Ollama requests on stop
        { colonyId, maxWorkers: MAX_WORKERS_PER_COLONY, agentHistories, delegatedSteps, workersCreated },
      );

      addEntry({ kind: 'message', agent: 'Orchestrator', content: response });
      onEvent({ type: 'orchestrator_message', content: response, round: outer + 1 });

      if (signal?.aborted) break;

      // Completion detection — prefer the explicit mark_goal_achieved signal,
      // fall back to a GOAL ACHIEVED: text sentinel for models that skip the
      // structured tool.
      if (goalSummary) {
        db.prepare('UPDATE colonies SET summary=? WHERE id=?').run(goalSummary, colonyId);
        completed = true;
        break;
      }
      const match = response.match(/GOAL ACHIEVED:\s*([\s\S]+?)(?:\n\n|$)/i);
      if (match) {
        db.prepare('UPDATE colonies SET summary=? WHERE id=?').run(match[1].trim(), colonyId);
        completed = true;
        break;
      }

      if (outer < MAX_OUTER_ROUNDS - 1) {
        // Build a state-aware nudge based on the current plan and worker list in the DB.
        const planRow = db.prepare('SELECT plan, agent_ids, orchestrator_id FROM colonies WHERE id=?').get(colonyId);
        const plan = planRow?.plan ? JSON.parse(planRow.plan) : null;

        // Always include current worker list so the orchestrator never needs to invent IDs.
        const allIds = JSON.parse(planRow?.agent_ids || '[]');
        const orchId = planRow?.orchestrator_id;
        const workerIds = allIds.filter(id => id !== orchId);
        const workerLines = workerIds.map(id => {
          const a = readAgent(id);
          return a ? `  • "${a.name}" → agent_id: "${a.id}"` : null;
        }).filter(Boolean);

        let nudge = `Round ${outer + 2} of ${MAX_OUTER_ROUNDS}.\n`;

        if (workerLines.length > 0) {
          nudge += `\nYour workers (use these exact agent_id values in ask_agent):\n${workerLines.join('\n')}\n`;
        }

        if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
          nudge += '\nYou have not called set_plan yet. Call it NOW with 3–6 concrete steps before creating workers or doing anything else.\n';
        } else {
          const done = plan.steps.filter(s => s.status === 'done');
          const pending = plan.steps.filter(s => s.status !== 'done');

          if (done.length > 0) {
            const doneLines = done.map(s => `  ✓ [DONE] ${s.id}. ${s.description}`);
            nudge += `\nCompleted steps (do NOT reopen, do NOT call set_plan):\n${doneLines.join('\n')}\n`;
          }

          if (pending.length === 0) {
            nudge += '\n*** ALL STEPS DONE *** Call mark_goal_achieved RIGHT NOW with a summary of what was accomplished. Do NOT create new steps or call set_plan — the plan is complete.\n';
          } else {
            const lines = pending.map(s => {
              const alreadyDelegated = delegatedSteps.has(String(s.id));
              const hint = (s.status === 'in_progress' && alreadyDelegated)
                ? ' ← ask_agent already called; mark this DONE now'
                : s.status === 'in_progress'
                  ? ' ← call ask_agent to do the work, then mark done'
                  : '';
              return `  - [${s.status}] ${s.id}. ${s.description}${s.assigned_to ? ' → ' + s.assigned_to : ''}${hint}`;
            });
            nudge += `\nRemaining steps:\n${lines.join('\n')}\n\nAddress errors above, then continue with the next step. If a step is in_progress and ask_agent already ran for it, mark it done immediately.\n`;
          }
        }

        messages.push({ role: 'assistant', content: response });
        messages.push({ role: 'user', content: nudge });
      }
    }

    // If we exhausted rounds without completion, fail loudly with a diagnostic
    // instead of pretending the run succeeded.
    if (!completed && !signal?.aborted) {
      const planRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyId);
      const plan = planRow?.plan ? JSON.parse(planRow.plan) : null;
      const pending = plan?.steps?.filter(s => s.status !== 'done') || [];
      const detail = plan
        ? `${pending.length} of ${plan.steps.length} plan steps still unfinished: ${pending.map(s => s.id).join(', ') || '(none)'}`
        : 'no plan was ever set';
      throw new Error(
        `Colony did not call mark_goal_achieved within ${MAX_OUTER_ROUNDS} review rounds. The orchestrator stalled (${detail}). Try a more specific goal, a stronger model, or re-run to retry.`,
      );
    }

    const status = signal?.aborted ? 'stopped' : 'done';
    db.prepare('UPDATE colonies SET status=?, updated_at=unixepoch() WHERE id=?').run(status, colonyId);
    addEntry({ kind: 'done', status });
    flush();
    onEvent({ type: 'done', status });

  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'Colony run was stopped' || signal?.aborted) {
      db.prepare("UPDATE colonies SET status='stopped', updated_at=unixepoch() WHERE id=?").run(colonyId);
      addEntry({ kind: 'done', status: 'stopped' });
      flush();
      onEvent({ type: 'done', status: 'stopped' });
    } else {
      db.prepare("UPDATE colonies SET status='error', updated_at=unixepoch() WHERE id=?").run(colonyId);
      addEntry({ kind: 'error', message: e.message });
      flush();
      onEvent({ type: 'error', message: e.message });
    }
  } finally {
    // Drop the per-colony bus if no subscribers remain. If tail clients are
    // still attached, they'll trigger cleanup on their own disconnect.
    try { maybeCleanup(colonyId); } catch {}
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
  }
  return out;
}

function truncateResult(result) {
  if (result === null || result === undefined) return result;
  const str = JSON.stringify(result);
  if (str.length <= 2000) return result;
  if (typeof result === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(result)) {
      out[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v;
    }
    return out;
  }
  return String(result).slice(0, 2000) + '…';
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function createColony(goal, model) {
  const id = newId();
  db.prepare('INSERT INTO colonies (id, goal, model) VALUES (?, ?, ?)').run(id, goal, model);
  return id;
}

function listColonies() {
  return db.prepare(
    'SELECT id, goal, model, status, orchestrator_id, agent_ids, summary, created_at FROM colonies ORDER BY created_at DESC',
  ).all().map(r => ({ ...r, agent_ids: JSON.parse(r.agent_ids || '[]') }));
}

function getColony(id) {
  const row = db.prepare('SELECT * FROM colonies WHERE id=?').get(id);
  if (!row) return null;
  const agents = JSON.parse(row.agent_ids || '[]').map(aid => {
    const a = readAgent(aid);
    return a ? { id: a.id, name: a.name, persona_role: a.persona_role, avatar_color: a.avatar_color } : null;
  }).filter(Boolean);
  let plan = null;
  if (row.plan) { try { plan = JSON.parse(row.plan); } catch {} }
  return {
    ...row,
    agent_ids: JSON.parse(row.agent_ids || '[]'),
    agents,
    log: JSON.parse(row.log || '[]'),
    plan,
  };
}

function deleteColony(id) {
  const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(id);
  if (!row) return;
  const ids = JSON.parse(row.agent_ids || '[]');
  const { deleteAgent } = require('./agentParser');
  for (const agentId of ids) {
    try { deleteAgent(agentId); } catch {}
  }
  db.prepare('DELETE FROM colonies WHERE id=?').run(id);
}

module.exports = { runColony, createColony, listColonies, getColony, deleteColony, truncateArgs, truncateResult };
