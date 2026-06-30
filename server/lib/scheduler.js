const cron = require('node-cron');
const db = require('../db');
const { readAgent } = require('./agentParser');
const { runAgentOnce } = require('./agentTools');
const { getOllamaUrl } = require('./ollamaUrl');
const { logSwallowed } = require('./logSwallowed');
const path = require('path');
const os = require('os');

// Map of schedule id → cron.ScheduledTask
const tasks = new Map();

function getSettings() {
  return {
    ollamaUrl: getOllamaUrl(),
    hivePath: path.join(os.homedir(), '.hive'),
  };
}

function runSchedule(schedule) {
  const agent = readAgent(schedule.agent_id);
  if (!agent) {
    db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_error=? WHERE id=?')
      .run('Agent not found', schedule.id);
    return;
  }
  if (!agent.model) {
    db.prepare('UPDATE scheduled_runs SET last_run=unixepoch(), last_error=? WHERE id=?')
      .run('Agent has no model configured', schedule.id);
    return;
  }

  const { ollamaUrl, hivePath } = getSettings();

  let toolsOverride = null;
  try {
    const parsed = JSON.parse(schedule.tools || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) toolsOverride = parsed;
  } catch (e) { logSwallowed('scheduler:parseTools', e, { scheduleId: schedule.id }); }

  runAgentOnce(agent, [{ role: 'user', content: schedule.prompt }], ollamaUrl, 0, null, hivePath, toolsOverride)
    .then((output) => {
      db.prepare(
        'UPDATE scheduled_runs SET last_run=unixepoch(), last_output=?, last_error=NULL, run_count=run_count+1 WHERE id=?',
      ).run(output, schedule.id);
    })
    .catch((err) => {
      db.prepare(
        'UPDATE scheduled_runs SET last_run=unixepoch(), last_error=?, run_count=run_count+1 WHERE id=?',
      ).run(err.message, schedule.id);
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

function loadAll() {
  const rows = db.prepare('SELECT * FROM scheduled_runs').all();
  for (const row of rows) register(row);
  console.log(`[scheduler] loaded ${rows.length} schedule(s)`);
}

module.exports = { loadAll, register, unregister, runSchedule, scheduledCount: () => tasks.size };
