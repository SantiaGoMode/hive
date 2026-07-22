const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const automationJobs = require('../lib/automationJobs');

const prefix = `test-${Date.now()}-`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  db.prepare('DELETE FROM automation_jobs WHERE kind LIKE ?').run(`${prefix}%`);
});

describe('durable automation jobs', () => {
  it('deduplicates by idempotency key and records a policy snapshot', async () => {
    const kind = `${prefix}success`;
    automationJobs.registerHandler(kind, async () => ({ resultRef: 'result-1' }));
    const first = automationJobs.enqueue({
      kind, source: 'test', sourceRef: 'source-1', idempotencyKey: `${prefix}idem`,
      payload: { privatePrompt: 'not listed' }, policy: { source: 'test', allowWrite: false },
    });
    const duplicate = automationJobs.enqueue({
      kind, source: 'test', sourceRef: 'source-1', idempotencyKey: `${prefix}idem`,
    });
    assert.equal(duplicate.id, first.id);
    await sleep(30);
    const stored = db.prepare('SELECT * FROM automation_jobs WHERE id=?').get(first.id);
    assert.equal(stored.status, 'succeeded');
    assert.equal(stored.attempt, 1);
    assert.equal(stored.result_ref, 'result-1');
    assert.deepEqual(JSON.parse(stored.policy), { source: 'test', allowWrite: false });
    const listed = automationJobs.list({ status: 'succeeded' }).find(row => row.id === first.id);
    assert.equal(listed.payload, undefined);
    assert.equal(listed.has_payload, true);
  });

  it('dead-letters exhausted work and permits explicit replay', async () => {
    const kind = `${prefix}replay`;
    let shouldFail = true;
    automationJobs.registerHandler(kind, async () => {
      if (shouldFail) throw new Error('synthetic failure');
      return { resultRef: 'recovered' };
    });
    const job = automationJobs.enqueue({
      kind, source: 'test', idempotencyKey: `${prefix}dead`, maxAttempts: 1,
    });
    await sleep(30);
    assert.equal(db.prepare('SELECT status FROM automation_jobs WHERE id=?').get(job.id).status, 'dead_letter');
    shouldFail = false;
    assert.equal(automationJobs.replay(job.id), true);
    await sleep(30);
    const replayed = db.prepare('SELECT status, attempt, result_ref FROM automation_jobs WHERE id=?').get(job.id);
    assert.deepEqual(replayed, { status: 'succeeded', attempt: 1, result_ref: 'recovered' });
  });

  it('requeues work whose in-memory owner disappeared', async () => {
    const kind = `${prefix}recover`;
    automationJobs.registerHandler(kind, async () => ({ resultRef: 'recovered-after-restart' }));
    const id = `${prefix}running`;
    db.prepare(`
      INSERT INTO automation_jobs
        (id, kind, source, idempotency_key, status, lease_owner, lease_expires_at, attempt)
      VALUES (?, ?, 'test', ?, 'running', 'dead-process', unixepoch()+600, 1)
    `).run(id, kind, id);
    assert.equal(automationJobs.recover(), 1);
    await sleep(30);
    const row = db.prepare('SELECT status, result_ref FROM automation_jobs WHERE id=?').get(id);
    assert.deepEqual(row, { status: 'succeeded', result_ref: 'recovered-after-restart' });
  });
});
