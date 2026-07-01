const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const lifecycle = require('../lib/schedulerLifecycle');
const scheduler = require('../lib/scheduler');
const staffScheduler = require('../lib/staffScheduler');
const db = require('../db');

afterEach(() => {
  try { lifecycle.stopAll(['scheduler', 'staffScheduler']); } catch {}
  try { scheduler.stopAll(); } catch {}
  db.prepare('DELETE FROM staff_profiles').run();
});

describe('scheduler lifecycle registry', () => {
  it('exposes both scheduler loops for metrics consumers', () => {
    const statuses = lifecycle.statuses();

    assert.ok(statuses.scheduler, 'cron scheduler is registered');
    assert.ok(statuses.staffScheduler, 'staff scheduler is registered');
    assert.equal(statuses.scheduler.active_task_count, scheduler.scheduledCount());
    assert.equal(statuses.staffScheduler.started, false);
  });

  it('starts and stops a registered loop idempotently', () => {
    const before = staffScheduler.status();

    lifecycle.startAll(['staffScheduler']);
    lifecycle.startAll(['staffScheduler']);
    const started = staffScheduler.status();

    assert.equal(started.running, true);
    assert.equal(started.started, true);
    assert.equal(started.start_count, before.start_count + 1);

    lifecycle.stopAll(['staffScheduler']);
    lifecycle.stopAll(['staffScheduler']);
    const stopped = staffScheduler.status();

    assert.equal(stopped.running, false);
    assert.equal(stopped.started, false);
    assert.equal(stopped.stop_count, before.stop_count + 1);
  });

  it('records staff scheduler heartbeat when a tick completes', async () => {
    const before = staffScheduler.status();

    const created = await staffScheduler.tick();
    const status = staffScheduler.status();

    assert.deepEqual(created, []);
    assert.equal(status.tick_count, before.tick_count + 1);
    assert.ok(status.last_tick_at, 'last tick timestamp is exposed');
    assert.equal(status.ticking, false);
  });

  it('records cron scheduler heartbeat and last error for schedule runs', () => {
    const before = scheduler.status();

    scheduler.runSchedule({ id: 'missing-agent-schedule', agent_id: 'missing-agent', prompt: 'go', tools: '[]' });
    const status = scheduler.status();

    assert.equal(status.tick_count, before.tick_count + 1);
    assert.ok(status.last_tick_at, 'last tick timestamp is exposed');
    assert.match(status.last_error, /Agent not found/);
  });
});
