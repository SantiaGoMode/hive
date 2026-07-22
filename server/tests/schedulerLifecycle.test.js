const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const lifecycle = require('../lib/schedulerLifecycle');
const scheduler = require('../lib/scheduler');
const db = require('../db');

afterEach(() => {
  try { lifecycle.stopAll(['scheduler']); } catch {}
  try { scheduler.stopAll(); } catch {}
  db.prepare('DELETE FROM staff_profiles').run();
});

describe('scheduler lifecycle registry', () => {
  it('exposes the scheduler loop for metrics consumers', () => {
    const statuses = lifecycle.statuses();

    assert.ok(statuses.scheduler, 'cron scheduler is registered');
    assert.equal(statuses.scheduler.active_task_count, scheduler.scheduledCount());
  });

  it('starts and stops a registered loop idempotently', () => {
    const before = lifecycle.status('scheduler');

    lifecycle.startAll(['scheduler']);
    lifecycle.startAll(['scheduler']);
    const started = lifecycle.status('scheduler');

    assert.equal(started.running, true);
    assert.equal(started.start_count, before.start_count + 1);

    lifecycle.stopAll(['scheduler']);
    lifecycle.stopAll(['scheduler']);
    const stopped = lifecycle.status('scheduler');

    assert.equal(stopped.running, false);
    assert.equal(stopped.stop_count, before.stop_count + 1);
  });

  it('records cron scheduler heartbeat and last error for schedule runs', () => {
    const before = scheduler.status();

    scheduler.runSchedule({ id: 'missing-agent-schedule', agent_id: 'missing-agent', prompt: 'go', tools: '[]' });
    const status = scheduler.status();

    assert.equal(status.tick_count, before.tick_count + 1);
    assert.ok(status.last_tick_at, 'last tick timestamp is exposed');
    assert.match(status.last_error, /Agent not found/);
  });

  it('records valid direct schedules in the durable automation ledger', () => {
    const agentId = `scheduled-agent-${Date.now()}`;
    const scheduleId = `durable-schedule-${Date.now()}`;
    db.prepare('INSERT INTO agents (id, name, model) VALUES (?, ?, ?)').run(agentId, 'Scheduled test', 'fake-model');
    db.prepare(`
      INSERT INTO scheduled_runs (id, agent_id, label, cron_expr, prompt, tools)
      VALUES (?, ?, 'Durable', '0 9 * * *', 'work', '[]')
    `).run(scheduleId, agentId);
    try {
      const job = scheduler.runSchedule(db.prepare('SELECT * FROM scheduled_runs WHERE id=?').get(scheduleId));
      assert.equal(job.kind, 'schedule');
      assert.equal(job.source_ref, scheduleId);
      assert.equal(JSON.parse(job.policy).source, 'schedule');
    } finally {
      db.prepare("DELETE FROM automation_jobs WHERE kind='schedule' AND source_ref=?").run(scheduleId);
      db.prepare('DELETE FROM scheduled_runs WHERE id=?').run(scheduleId);
      db.prepare('DELETE FROM agents WHERE id=?').run(agentId);
    }
  });
});
