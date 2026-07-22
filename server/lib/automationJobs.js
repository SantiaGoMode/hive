const crypto = require('crypto');
const db = require('../db');
const { logger } = require('./logger');
const automationQueue = require('./automationQueue');

const OWNER = `${process.pid}-${crypto.randomUUID()}`;
const LEASE_SECONDS = Math.max(15, Number(process.env.HIVE_AUTOMATION_LEASE_SECONDS) || 120);
const POLL_MS = Math.max(250, Number(process.env.HIVE_AUTOMATION_POLL_MS) || 1_000);
const handlers = new Map();
const active = new Map();
const dispatched = new Set();
let timer = null;
let enabled = true;

function parse(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function enqueue({ kind, source, sourceRef = null, idempotencyKey, payload = {}, policy = {}, maxAttempts = 3 }) {
  if (!handlers.has(kind)) logger.warn('automationJobs', 'handler_not_registered', { kind });
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT OR IGNORE INTO automation_jobs
      (id, kind, source, source_ref, idempotency_key, payload, policy, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, kind, source, sourceRef, idempotencyKey || id,
    JSON.stringify(payload), JSON.stringify(policy), Math.max(1, Number(maxAttempts) || 3),
  );
  const row = db.prepare('SELECT * FROM automation_jobs WHERE idempotency_key=?').get(idempotencyKey || id);
  setImmediate(drain);
  return row;
}

function claimNext() {
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM automation_jobs
      WHERE (
        (status IN ('queued','retry_wait') AND COALESCE(next_attempt_at,0) <= unixepoch())
        OR (status='running' AND COALESCE(lease_expires_at,0) <= unixepoch())
      )
      AND attempt < max_attempts
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get();
    if (!row || !handlers.has(row.kind)) return null;
    const leaseOwner = `${OWNER}:${crypto.randomUUID()}`;
    const changed = db.prepare(`
      UPDATE automation_jobs
      SET status='running', lease_owner=?, lease_expires_at=unixepoch()+?,
          attempt=attempt+1, started_at=COALESCE(started_at,unixepoch()), updated_at=unixepoch()
      WHERE id=? AND attempt=? AND (
        status IN ('queued','retry_wait') OR (status='running' AND COALESCE(lease_expires_at,0) <= unixepoch())
      )
    `).run(leaseOwner, LEASE_SECONDS, row.id, row.attempt);
    return changed.changes
      ? db.prepare('SELECT * FROM automation_jobs WHERE id=?').get(row.id)
      : null;
  })();
}

function retryDelaySeconds(attempt) {
  return Math.min(300, 5 * (2 ** Math.max(0, attempt - 1)));
}

async function execute(job) {
  const handler = handlers.get(job.kind);
  if (!handler) return;
  const controller = new AbortController();
  active.set(job.id, { leaseOwner: job.lease_owner, controller });
  const heartbeat = setInterval(() => {
    const renewed = db.prepare(`
      UPDATE automation_jobs SET lease_expires_at=unixepoch()+?, updated_at=unixepoch()
      WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
    `).run(LEASE_SECONDS, job.id, job.lease_owner, job.attempt);
    if (!renewed.changes) {
      controller.abort(new Error('Automation job lease lost'));
      logger.error('automationJobs', 'lease_lost', { jobId: job.id, attempt: job.attempt });
    }
  }, Math.max(5_000, Math.floor(LEASE_SECONDS * 500)));
  heartbeat.unref?.();
  try {
    const result = await handler(parse(job.payload), {
      ...job,
      policy: parse(job.policy),
      signal: controller.signal,
    });
    db.prepare(`
      UPDATE automation_jobs
      SET status='succeeded', result_ref=?, lease_owner=NULL, lease_expires_at=NULL,
          finished_at=unixepoch(), updated_at=unixepoch()
      WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
    `).run(result?.resultRef || null, job.id, job.lease_owner, job.attempt);
  } catch (error) {
    const terminal = job.attempt >= job.max_attempts;
    db.prepare(`
      UPDATE automation_jobs
      SET status=?, last_error=?, next_attempt_at=?, lease_owner=NULL, lease_expires_at=NULL,
          finished_at=CASE WHEN ? THEN unixepoch() ELSE NULL END, updated_at=unixepoch()
      WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
    `).run(
      terminal ? 'dead_letter' : 'retry_wait',
      String(error?.message || error).slice(0, 2_000),
      terminal ? null : Math.floor(Date.now() / 1000) + retryDelaySeconds(job.attempt),
      terminal ? 1 : 0,
      job.id, job.lease_owner, job.attempt,
    );
    logger.error('automationJobs', terminal ? 'dead_lettered' : 'attempt_failed', {
      jobId: job.id, kind: job.kind, attempt: job.attempt, error: error?.message || String(error),
    });
  } finally {
    clearInterval(heartbeat);
    active.delete(job.id);
    dispatched.delete(job.id);
    setImmediate(drain);
  }
}

function drain() {
  if (!enabled) return;
  // automationQueue owns the global concurrency cap. Claim only a bounded
  // number beyond active work so the durable ledger remains the primary queue.
  const queue = automationQueue.status();
  const capacity = Math.max(0, queue.max_concurrent - queue.active - queue.queued);
  for (let i = 0; i < capacity; i++) {
    const job = claimNext();
    if (!job) break;
    dispatched.add(job.id);
    automationQueue.scheduleAutomation(() => execute(job)).catch((error) => {
      dispatched.delete(job.id);
      logger.error('automationJobs', 'dispatch_failed', {
        jobId: job.id,
        error: error?.message || String(error),
      });
      setImmediate(drain);
    });
  }
}

function recover() {
  const changed = db.prepare(`
    UPDATE automation_jobs
    SET status='queued', lease_owner=NULL, lease_expires_at=NULL, updated_at=unixepoch()
    WHERE status='running'
  `).run().changes;
  setImmediate(drain);
  return changed;
}

function replay(id) {
  const changed = db.prepare(`
    UPDATE automation_jobs
    SET status='queued', attempt=0, next_attempt_at=NULL, last_error=NULL,
        lease_owner=NULL, lease_expires_at=NULL, finished_at=NULL, updated_at=unixepoch()
    WHERE id=? AND status='dead_letter'
  `).run(id).changes;
  if (changed) setImmediate(drain);
  return changed > 0;
}

function registerHandler(kind, handler) {
  handlers.set(kind, handler);
  setImmediate(drain);
}

function activeFor(kind, sourceRef) {
  return db.prepare(`
    SELECT * FROM automation_jobs
    WHERE kind=? AND source_ref=? AND status IN ('queued','running','retry_wait')
    ORDER BY created_at DESC LIMIT 1
  `).get(kind, sourceRef) || null;
}

function status() {
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS count FROM automation_jobs GROUP BY status').all()
    .map(row => [row.status, row.count]));
  return { active: active.size, dispatched: dispatched.size, counts };
}

function list({ status: jobStatus = null, limit = 100 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 100, 500));
  const rows = jobStatus
    ? db.prepare('SELECT * FROM automation_jobs WHERE status=? ORDER BY created_at DESC LIMIT ?').all(jobStatus, capped)
    : db.prepare('SELECT * FROM automation_jobs ORDER BY created_at DESC LIMIT ?').all(capped);
  return rows.map(({ payload, policy, lease_owner, ...row }) => ({
    ...row,
    policy: parse(policy),
    has_payload: Boolean(payload),
    lease_owner: lease_owner ? '[active lease]' : null,
  }));
}

function start() {
  enabled = true;
  if (timer) return;
  timer = setInterval(drain, POLL_MS);
  timer.unref?.();
  drain();
}

function stop() {
  enabled = false;
  if (timer) clearInterval(timer);
  timer = null;
  for (const { controller } of active.values()) {
    controller.abort(new Error('Automation worker stopped'));
  }
}

module.exports = {
  activeFor, drain, enqueue, list, recover, registerHandler, replay, start, status, stop,
  _claimNext: claimNext,
};
