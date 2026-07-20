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
const { scheduleAutomation } = require('./automationQueue');

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

function runSchedule(schedule) {
  if (running.has(schedule.id)) {
    lifecycle.heartbeat('scheduler', { schedule_id: schedule.id, event: 'skip_overlapping_run' });
    db.prepare('UPDATE scheduled_runs SET last_error=? WHERE id=?')
      .run('Skipped: previous run still in progress', schedule.id);
    return;
  }
  lifecycle.heartbeat('scheduler', { schedule_id: schedule.id, event: 'run' });

  // Pipeline target: run the whole pipeline with the schedule's prompt as
  // input and store its final output. Required lazily — the module graph
  // scheduler → pipelineRunner → agentTools → registry would otherwise load
  // this module before its exports exist.
  if (schedule.pipeline_id) {
    const { runPipelineById } = require('./pipelineRunner');
    running.add(schedule.id);
    scheduleAutomation(() => runPipelineById(schedule.pipeline_id, schedule.prompt, {
      hivePath: getSettings().hivePath,
      runContext: unattendedRunContext('schedule'),
    }))
      .then(({ final_output }) => {
        db.prepare(
          'UPDATE scheduled_runs SET last_run=unixepoch(), last_output=?, last_error=NULL, run_count=run_count+1 WHERE id=?',
        ).run(final_output, schedule.id);
      })
      .catch((err) => {
        lifecycle.recordError('scheduler', err);
        db.prepare(
          'UPDATE scheduled_runs SET last_run=unixepoch(), last_error=?, run_count=run_count+1 WHERE id=?',
        ).run(err.message, schedule.id);
      })
      .finally(() => {
        running.delete(schedule.id);
      });
    return;
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
      return;
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
    return;
  }

  const agent = readAgent(schedule.agent_id);
  if (!agent) {
    db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_error=? WHERE id=?')
      .run('Agent not found', schedule.id);
    lifecycle.recordError('scheduler', `Agent not found: ${schedule.agent_id}`);
    return;
  }
  if (!agent.model) {
    db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_error=? WHERE id=?')
      .run('Agent has no model configured', schedule.id);
    lifecycle.recordError('scheduler', `Agent has no model configured: ${schedule.agent_id}`);
    return;
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
  scheduleAutomation(() => runAgentOnce(agent, [{ role: 'user', content: schedule.prompt }], ollamaUrl, 0, null, hivePath, toolsOverride, undefined, null, runCtx))
    .then((output) => {
      db.prepare(
        'UPDATE scheduled_runs SET last_run=unixepoch(), last_output=?, last_error=NULL, run_count=run_count+1 WHERE id=?',
      ).run(output, schedule.id);
    })
    .catch((err) => {
      lifecycle.recordError('scheduler', err);
      db.prepare(
        'UPDATE scheduled_runs SET last_run=unixepoch(), last_error=?, run_count=run_count+1 WHERE id=?',
      ).run(err.message, schedule.id);
    })
    .finally(() => {
      running.delete(schedule.id);
    });
}

function register(schedule) {
  if (tasks.has(schedule.id)) {
    tasks.get(schedule.id).stop();
    tasks.delete(schedule.id);
  }
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cron_expr)) return;

  const task = cron.schedule(schedule.cron_expr, () => runSchedule(schedule), { scheduled: true });
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

module.exports = {
  loadAll,
  register,
  unregister,
  stopAll,
  runSchedule,
  status,
  scheduledCount: () => tasks.size,
};
