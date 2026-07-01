// Colony run orchestration.
// Owns the run registry (runningColonies) and the runColony control flow:
// load row/config, preflight models, checkout the git branch, seed the recipe
// crew (or bootstrap tasks), run the operator/worker review loop, finalize,
// write back to GitHub, and update colony memory. Cohesive concerns (git,
// preflight, seeding, event wiring, writeback, memory) live in sibling modules.
const { runAgentOnce } = require('../agentTools');
const { publish, maybeCleanup } = require('../colonyBus');
const protocol = require('../colonyProtocol');
const colonyModels = require('../colonyModels');
const sandbox = require('../sandbox');
const { fetchRepoBoard } = require('../githubBoard');
const { getOllamaUrl } = require('../ollamaUrl');
const {
  DEFAULT_RECIPE_ID,
  getColonyRecipe,
  isCustomAutoRecipe,
  recipeInitialMessage,
} = require('../colonyRecipes');
const db = require('../../db');
const { logSwallowed } = require('../logSwallowed');

const { runModelPreflightAndCheckout } = require('./preflight');
const { maybeRunBootstrap } = require('./bootstrap');
const { persistLog, drainPendingDirections, parseField } = require('./persistence');
const { makeFakeWs, makeColonyEventHandler } = require('./events');
const { createPerformWriteback, postBoardComment } = require('./writeback');
const { seedRecipeWorkers, createOrchestrator } = require('./seeding');
const { buildRoundNudge } = require('./loop');
const { updateColonyMemoryAfterRun } = require('./memory');

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

// Registry of in-flight runs, keyed by colonyId. Owned here (not in the route)
// so every launch path — POST /api/colony, bootstrap accept, webhook triggers —
// is stoppable via stopColonyRun() for the run's entire lifetime.
const runningColonies = new Map();

// Abort a running colony regardless of how it was launched.
// Returns true if a live run was found and aborted.
function stopColonyRun(colonyId) {
  const ac = runningColonies.get(colonyId);
  if (!ac) return false;
  try { ac.abort(); } catch {} /* abort is best-effort */
  return true;
}

function isColonyRunning(colonyId) {
  return runningColonies.has(colonyId);
}

function activeRunCount() {
  return runningColonies.size;
}

async function runColony(colonyId, onEventArg, signal) {
  // Internal AbortController for this run. An external signal (from the HTTP
  // route's timeout/disconnect handling) is chained into it; stopColonyRun()
  // aborts it directly. All internal checks use this controller's signal.
  const externalSignal = signal;
  const ac = new AbortController();
  const onExternalAbort = () => { try { ac.abort(); } catch {} /* abort is best-effort */ };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  signal = ac.signal;
  runningColonies.set(colonyId, ac);

  const logEntries = [];
  let logDirty = false;
  let seqCounter = 0;

  // Every event goes to: (a) the per-colony event bus for resumable SSE,
  // (b) the legacy onEvent callback if supplied (used by tests and the old
  // direct-streaming path). Either can be absent.
  const onEvent = (event) => {
    try { publish(colonyId, event); } catch (e) { logSwallowed('colonyRunner:publish', e, { colonyId }); }
    if (onEventArg) {
      try { onEventArg(event); } catch (e) { logSwallowed('colonyRunner:onEvent', e, { colonyId }); }
    }
  };

  // Persist log to DB immediately on every entry — avoids data loss on refresh/crash.
  const flush = () => {
    if (!logDirty) return;
    try {
      persistLog(colonyId, logEntries.slice(-LOG_MAX_ENTRIES));
    } catch (e) { logSwallowed('colonyRunner:persistLog', e, { colonyId }); }
    logDirty = false;
  };

  const addEntry = (entry) => {
    const e = { ...entry, ts: Date.now(), seq: ++seqCounter };
    logEntries.push(e);
    logDirty = true;
    onEvent({ type: 'log_entry', entry: e });
    flush();
  };

  // Mutable run state shared with the event handler (sets goalSummary on
  // mark_goal_achieved) and the writeback closure (reads row/githubWriteback/
  // goalSummary). Hoisted so writeback can run from BOTH the happy path and the
  // abort/stop path — partial work must still be pushed and PR'd.
  const state = {
    goalSummary: null,
    row: null,
    githubWriteback: false,
  };
  const colonyBranch = `colony-${colonyId}`;

  // ── Git write-back: commit, push, and open Draft PR ────────────────────────
  const performWriteback = createPerformWriteback({ colonyId, colonyBranch, addEntry, onEvent, state });

  const cleanupSandboxContainers = () => {
    let ids = [];
    try {
      const latest = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(colonyId);
      ids = JSON.parse(latest?.agent_ids || '[]');
    } catch (e) { logSwallowed('colonyRunner:cleanupSandbox', e, { colonyId }); }
    if (!ids.length) return;
    let removed = 0;
    for (const id of ids) {
      try { if (sandbox.cleanupContainer(id)) removed++; } catch (e) { logSwallowed('colonyRunner:cleanupContainer', e, { agentId: id }); }
    }
    if (removed > 0) {
      addEntry({ kind: 'sandbox_cleanup', message: `Cleaned up ${removed} sandbox container${removed === 1 ? '' : 's'}.`, removed });
    }
  };

  try {
    const row = db.prepare('SELECT * FROM colonies WHERE id=?').get(colonyId);
    if (!row) throw new Error(`Colony ${colonyId} not found`);
    state.row = row;

    const ollamaUrl = getOllamaUrl();

    // Per-role model plan + cloud setting. The operator (or user) may assign a
    // different model per role; fall back to the colony's single model.
    const modelPlan = parseField(row.model_plan, 'model_plan', null);

    // ── Pre-flight: cloud gating, per-model capability checks, git checkout ──
    const { operatorModel } = await runModelPreflightAndCheckout({
      colonyId, row, modelPlan, colonyBranch, ollamaUrl, addEntry, onEvent, state,
    });

    // Shared colony memory — durable knowledge from previous runs, maintained
    // by the operator and editable on the colony page. Injected into the
    // operator and every worker so lessons actually carry across runs.
    let teamRow = null;
    if (row.team_id) {
      try { teamRow = db.prepare('SELECT id, name, description, memory FROM colony_teams WHERE id=?').get(row.team_id); } catch (e) { logSwallowed('colonyRunner:loadTeam', e, { colonyId }); }
    }
    const colonyMemory = String(teamRow?.memory || '').trim();
    const memorySection = colonyMemory
      ? `\n\n[Colony Memory — shared knowledge from previous runs. Honor it; it encodes hard-won lessons.]\n${colonyMemory.slice(0, 6000)}`
      : '';
    if (colonyMemory) {
      addEntry({ kind: 'preflight', message: `🧠 Colony memory loaded (${colonyMemory.length} chars) — injected into operator and workers.` });
    }

    const recipe = getColonyRecipe(row.recipe_id || DEFAULT_RECIPE_ID);
    // Reasoning is decided by the operator at run start: the operator always
    // reasons; each agent's reasoning is assigned per role based on the
    // mission. (The old user-facing reasoning_mode toggle is gone.)
    const reasoningDecision = colonyModels.decideRoleReasoning({ recipe, goal: row.goal });
    const workerReasoningDefault = reasoningDecision.default;
    const reasoningByAgentId = new Map();
    if (!isCustomAutoRecipe(recipe.id)) {
      addEntry({ kind: 'recipe', recipe_id: recipe.id, name: recipe.name });
    }
    const roleReasoningSummary = Object.entries(reasoningDecision.by_role)
      .map(([k, on]) => `${k}=${on ? 'on' : 'off'}`).join(', ');
    addEntry({
      kind: 'preflight',
      message: `Reasoning (operator decision): operator on; ${roleReasoningSummary || `workers ${workerReasoningDefault ? 'on' : 'off'}`} — ${reasoningDecision.rationale}.`,
    });

    // Recipe-driven colonies create a known roster before the operator starts.
    // The orchestrator then delegates to these exact IDs instead of inventing
    // worker roles and prompts at runtime.
    const recipeWorkers = [];
    if (!isCustomAutoRecipe(recipe.id)) {
      seedRecipeWorkers({
        colonyId, row, recipe, modelPlan, teamRow, memorySection,
        reasoningDecision, workerReasoningDefault, reasoningByAgentId,
        recipeWorkers, addEntry,
      });
    }

    // Empty-board bootstrap: draft + await human-approved tasks before running.
    const bootstrapped = await maybeRunBootstrap({
      colonyId, row, recipe, recipeWorkers, ollamaUrl, signal,
      reasoningByAgentId, workerReasoningDefault,
      fetchRepoBoard, runAgentOnce, addEntry, onEvent, flush,
    });
    if (bootstrapped) return;

    // ── Create orchestrator + emit agent_ready for the crew ───────────────────
    const orch = createOrchestrator({
      colonyId, row, recipe, recipeWorkers, operatorModel, memorySection,
      reasoningByAgentId, addEntry, onEvent,
    });

    // ── Wire up live event stream ─────────────────────────────────────────────
    const fakeWs = makeFakeWs(makeColonyEventHandler({ colonyId, signal, addEntry, onEvent, state }));

    // ── Orchestrator run loop ─────────────────────────────────────────────────
    let initialContent = recipeInitialMessage(recipe);
    if (row.bootstrap_accepted && row.bootstrap_tasks) {
      const acceptedTasks = parseField(row.bootstrap_tasks, 'bootstrap_tasks', []);
      if (acceptedTasks.length) {
        initialContent += `\n\nHuman-approved bootstrap tasks are already accepted for this empty-board repo. Use these as the delivery scope; do not invent a different backlog. If you call set_plan, preserve this task order:\n${acceptedTasks.map(t => `- ${t.id}. ${t.title}: ${t.description || ''}`).join('\n')}`;
      }
    }
    const messages = [{
      role: 'user',
      content: initialContent,
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
    const workersCreated = new Set(recipeWorkers.map(worker => worker.id));

    // Map each seeded worker's agent_id → its protocol role key so the
    // Communication Protocol tools (handoff, blackboard_write, …) can attribute
    // entries and enforce the role-specific flow without the agent guessing.
    const roleByAgentId = new Map();
    for (const worker of recipeWorkers) {
      if (worker.role_key) roleByAgentId.set(worker.id, worker.role_key);
    }

    // Outer review loop: runAgentOnce does one "turn" with up to 20 tool-call
    // rounds internally. Between turns we check for completion and, if not
    // done, inject a state-aware nudge showing the current plan status.
    const MAX_OUTER_ROUNDS = 6;
    let completed = false;

    for (let outer = 0; outer < MAX_OUTER_ROUNDS; outer++) {
      if (signal?.aborted) break;

      const directions = drainPendingDirections(colonyId);
      if (directions.length > 0) {
        const directionText = directions.map(d =>
          `- Direction #${d.id}${d.target_role ? ` for ${d.target_role}` : ''}: ${d.content}`,
        ).join('\n');
        const injected = [
          'HIGH PRIORITY USER DIRECTION',
          'Treat this as authoritative. Adjust the current plan with add_plan_step/update_plan_step as needed. Acknowledge how you applied it in your next response.',
          directionText,
        ].join('\n');
        messages.push({ role: 'user', content: injected });
        for (const d of directions) {
          addEntry({ kind: 'direction', direction_id: d.id, status: 'delivered', content: d.content, target_role: d.target_role || null });
          onEvent({ type: 'direction_delivered', direction: { id: d.id, content: d.content, target_role: d.target_role || null } });
        }
      }

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
        {
          colonyId,
          // The worker cap only guards the custom_auto path, where the orchestrator
          // spawns workers via create_agent. Seeded recipe crews have a fixed roster
          // and must not be capped — null disables the guard.
          maxWorkers: isCustomAutoRecipe(recipe.id) ? MAX_WORKERS_PER_COLONY : null,
          agentHistories,
          delegatedSteps,
          workersCreated,
          recipeId: recipe.id,
          roleByAgentId,
          reasoningByAgentId,
          workerReasoningDefault,
        },
      );

      addEntry({ kind: 'message', agent: 'Orchestrator', content: response });
      onEvent({ type: 'orchestrator_message', content: response, round: outer + 1 });

      if (signal?.aborted) break;

      // Completion detection — prefer the explicit mark_goal_achieved signal,
      // fall back to a GOAL ACHIEVED: text sentinel for models that skip the
      // structured tool.
      if (state.goalSummary) {
        db.prepare('UPDATE colonies SET summary=? WHERE id=?').run(state.goalSummary, colonyId);
        completed = true;
        break;
      }
      // Text-sentinel completion is a fallback for weak models that skip the
      // structured tool. It is DISABLED for protocol recipes — those must finish
      // through the gated mark_goal_achieved so the handoff flow and human gates
      // are actually honored (no declaring victory in prose).
      if (!protocol.hasProtocol(recipe.id)) {
        const match = response.match(/GOAL ACHIEVED:\s*([\s\S]+?)(?:\n\n|$)/i);
        if (match) {
          db.prepare('UPDATE colonies SET summary=? WHERE id=?').run(match[1].trim(), colonyId);
          completed = true;
          break;
        }
      }

      if (outer < MAX_OUTER_ROUNDS - 1) {
        const nudge = buildRoundNudge({ colonyId, outer, maxOuterRounds: MAX_OUTER_ROUNDS, delegatedSteps });
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

    await performWriteback(status);

    // Operator memory upkeep — distill lessons from this run into the colony's
    // shared memory so the next run starts smarter.
    try { await updateColonyMemoryAfterRun(colonyId, row, state.goalSummary, status, addEntry); } catch (e) { logSwallowed('colonyRunner:memoryUpdate', e, { colonyId }); }

    if (status === 'done' && row.board_card) {
      await postBoardComment({ colonyId, row, addEntry, onEvent });
    }

    cleanupSandboxContainers();
    addEntry({ kind: 'done', status });
    flush();
    onEvent({ type: 'done', status });

  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'Colony run was stopped' || signal?.aborted) {
      db.prepare("UPDATE colonies SET status='stopped', updated_at=unixepoch() WHERE id=?").run(colonyId);
      // Stopped runs still publish whatever real work landed on the branch.
      try { await performWriteback('stopped'); } catch (e) { logSwallowed('colonyRunner:writeback', e, { colonyId }); }
      // Partial runs often carry the most valuable lessons (what blocked them).
      try { await updateColonyMemoryAfterRun(colonyId, state.row, state.goalSummary, 'stopped', addEntry); } catch (e) { logSwallowed('colonyRunner:memoryUpdate', e, { colonyId }); }
      cleanupSandboxContainers();
      addEntry({ kind: 'done', status: 'stopped' });
      flush();
      onEvent({ type: 'done', status: 'stopped' });
    } else {
      db.prepare("UPDATE colonies SET status='error', updated_at=unixepoch() WHERE id=?").run(colonyId);
      cleanupSandboxContainers();
      addEntry({ kind: 'error', message: e.message });
      flush();
      onEvent({ type: 'error', message: e.message });
    }
  } finally {
    // Deregister this run so stopColonyRun() no longer finds it, and detach
    // the external-signal listener to avoid leaks on long-lived signals.
    runningColonies.delete(colonyId);
    if (externalSignal) {
      try { externalSignal.removeEventListener('abort', onExternalAbort); } catch {} /* removeEventListener is best-effort */
    }
    // Drop the per-colony bus if no subscribers remain. If tail clients are
    // still attached, they'll trigger cleanup on their own disconnect.
    try { maybeCleanup(colonyId); } catch (e) { logSwallowed('colonyRunner:busCleanup', e, { colonyId }); }
  }
}

module.exports = {
  runColony,
  stopColonyRun,
  isColonyRunning,
  activeRunCount,
  runningColonies,
};
