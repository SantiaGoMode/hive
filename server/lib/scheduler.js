const cron = require('node-cron');
const db = require('../db');
const { readAgent } = require('./agentParser');
const { runAgentOnce } = require('./agentTools');
const { getOllamaUrl } = require('./ollamaUrl');
const { logSwallowed } = require('./logSwallowed');
const lifecycle = require('./schedulerLifecycle');
const path = require('path');
const os = require('os');
const { unattendedRunContext } = require('./colonyPolicy');
const automationJobs = require('./automationJobs');

// Map of schedule id → cron.ScheduledTask
const tasks = new Map();

// Schedule ids with a run currently in flight. A slow run must not stack with
// the next cron fire of the same schedule.
const running = new Set();

function getSettings() {
  return {
    ollamaUrl: getOllamaUrl(),
    hivePath: path.join(os.homedir(), '.hive'),
  };
}

async function executeSchedule(schedule, { signal = null } = {}) {
  if (running.has(schedule.id)) {
    lifecycle.heartbeat('scheduler', { schedule_id: schedule.id, event: 'skip_overlapping_run' });
    db.prepare('UPDATE scheduled_runs SET last_error=? WHERE id=?')
      .run('Skipped: previous run still in progress', schedule.id);
    throw new Error('Skipped: previous run still in progress');
  }

  // Pipeline target: run the whole pipeline with the schedule's prompt as
  // input and store its final output. Required lazily — the module graph
  // scheduler → pipelineRunner → agentTools → registry would otherwise load
  // this module before its exports exist.
  if (schedule.pipeline_id) {
    const { runPipelineById } = require('./pipelineRunner');
    running.add(schedule.id);
    try {
      const { final_output, run_id } = await runPipelineById(schedule.pipeline_id, schedule.prompt, {
        hivePath: getSettings().hivePath,
        runContext: unattendedRunContext('schedule'),
        signal,
      });
      db.prepare(
        'UPDATE scheduled_runs SET last_run=unixepoch(), last_output=?, last_error=NULL, run_count=run_count+1 WHERE id=?',
      ).run(final_output, schedule.id);
      return { resultRef: run_id || null };
    } catch (err) {
      lifecycle.recordError('scheduler', err);
      db.prepare(
        'UPDATE scheduled_runs SET last_run=unixepoch(), last_error=?, run_count=run_count+1 WHERE id=?',
      ).run(err.message, schedule.id);
      throw err;
    } finally {
      running.delete(schedule.id);
    }
  }

  // Colony team target: launch (or queue, if the team is busy) a mission for the
  // team, using the schedule's prompt as the mission direction. Runs detached
  // like a Discord-launched mission; progress relays to the team's forum thread
  // automatically. Lazily required to avoid a boot-time cycle
  // (scheduler → discord/missions → colonyRunner → …).
  if (schedule.team_id) {
    const missions = require('./discord/missions');
    let model = null;
    try { model = require('./discord/operator').ensureOperatorAgent()?.model || null; }
    catch (e) { logSwallowed('scheduler:operatorModel', e, { scheduleId: schedule.id }); }
    if (!model) {
      db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_error=?, run_count=run_count+1 WHERE id=?')
        .run('No Operator model available to run the scheduled mission', schedule.id);
      lifecycle.recordError('scheduler', `No operator model for schedule ${schedule.id}`);
      throw new Error('No Operator model available to run the scheduled mission');
    }
    try {
      let output;
      if (missions.activeRunForTeam(schedule.team_id)) {
        const { item } = missions.queueTeamWork(schedule.team_id, schedule.prompt, schedule.label);
        output = `Team busy — queued work item ${item.id}`;
      } else {
        const { runId } = missions.launchTeamMission(schedule.team_id, schedule.prompt, {
          model, source: 'schedule', matchReason: `Scheduled: ${schedule.label}`,
        });
        output = `Launched run ${runId}`;
      }
      db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_output=?, last_error=NULL, run_count=run_count+1 WHERE id=?')
        .run(output, schedule.id);
    } catch (err) {
      lifecycle.recordError('scheduler', err);
      db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_error=?, run_count=run_count+1 WHERE id=?')
        .run(err.message, schedule.id);
    }
    return { resultRef: null };
  }

  const agent = readAgent(schedule.agent_id);
  if (!agent) {
    db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_error=? WHERE id=?')
      .run('Agent not found', schedule.id);
    lifecycle.recordError('scheduler', `Agent not found: ${schedule.agent_id}`);
    throw new Error('Agent not found');
  }
  if (!agent.model) {
    db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_error=? WHERE id=?')
      .run('Agent has no model configured', schedule.id);
    lifecycle.recordError('scheduler', `Agent has no model configured: ${schedule.agent_id}`);
    throw new Error('Agent has no model configured');
  }

  const { ollamaUrl, hivePath } = getSettings();

  let toolsOverride = null;
  try {
    const parsed = JSON.parse(schedule.tools || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) toolsOverride = parsed;
  } catch (e) { logSwallowed('scheduler:parseTools', e, { scheduleId: schedule.id }); }

  running.add(schedule.id);
  // Context labels gateway spend as 'schedule'; runAgentOnce also honors the
  // agent's own reasoning toggle on this path.
  const runCtx = unattendedRunContext('schedule');
  try {
    const output = await runAgentOnce(agent, [{ role: 'user', content: schedule.prompt }], ollamaUrl, 0, null, hivePath, toolsOverride, undefined, signal, runCtx);
    db.prepare(
      'UPDATE scheduled_runs SET last_run=unixepoch(), last_output=?, last_error=NULL, run_count=run_count+1 WHERE id=?',
    ).run(output, schedule.id);
    return { resultRef: null };
  } catch (err) {
    lifecycle.recordError('scheduler', err);
    db.prepare(
      'UPDATE scheduled_runs SET last_run=unixepoch(), last_error=?, run_count=run_count+1 WHERE id=?',
    ).run(err.message, schedule.id);
    throw err;
  } finally {
    running.delete(schedule.id);
  }
}

function runSchedule(schedule, { idempotencyKey = null } = {}) {
  lifecycle.heartbeat('scheduler', { schedule_id: schedule.id, event: 'run' });

  // Colony launches already land on Colony's durable queue. Direct agent and
  // pipeline schedules use the generic unattended-job ledger below.
  if (schedule.team_id) return executeSchedule(schedule).catch(() => null);

  // Configuration errors are deterministic and should surface immediately,
  // not consume retry attempts indefinitely.
  if (!schedule.pipeline_id) {
    const agent = readAgent(schedule.agent_id);
    if (!agent || !agent.model) return executeSchedule(schedule).catch(() => null);
  }

  const existing = automationJobs.activeFor('schedule', schedule.id);
  if (existing) {
    db.prepare('UPDATE scheduled_runs SET last_error=? WHERE id=?')
      .run('Skipped: previous run still in progress', schedule.id);
    lifecycle.heartbeat('scheduler', { schedule_id: schedule.id, event: 'skip_overlapping_run' });
    return existing;
  }

  return automationJobs.enqueue({
    kind: 'schedule',
    source: 'schedule',
    sourceRef: schedule.id,
    idempotencyKey: idempotencyKey || `schedule:${schedule.id}:manual:${Date.now()}`,
    payload: { schedule },
    policy: unattendedRunContext('schedule'),
  });
}

function register(schedule) {
  if (tasks.has(schedule.id)) {
    tasks.get(schedule.id).stop();
    tasks.delete(schedule.id);
  }
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cron_expr)) return;

  const task = cron.schedule(schedule.cron_expr, () => runSchedule(schedule, {
    idempotencyKey: `schedule:${schedule.id}:${Math.floor(Date.now() / 60_000)}`,
  }), { scheduled: true });
  tasks.set(schedule.id, task);
}

function unregister(id) {
  if (tasks.has(id)) {
    tasks.get(id).stop();
    tasks.delete(id);
  }
}

function stopAll() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
}

function loadAll() {
  const rows = db.prepare('SELECT * FROM scheduled_runs').all();
  for (const row of rows) register(row);
  lifecycle.heartbeat('scheduler', { event: 'load_all', schedule_count: rows.length, active_task_count: tasks.size });
  console.log(`[scheduler] loaded ${rows.length} schedule(s)`);
}

function status() {
  return lifecycle.status('scheduler');
}

function rawStatus() {
  return { active_task_count: tasks.size };
}

lifecycle.register('scheduler', { start: loadAll, stop: stopAll, status: rawStatus });
automationJobs.registerHandler('schedule', ({ schedule }, job) => executeSchedule(schedule, { signal: job.signal }));

module.exports = {
  loadAll,
  register,
  unregister,
  stopAll,
  runSchedule,
  status,
  scheduledCount: () => tasks.size,
};
