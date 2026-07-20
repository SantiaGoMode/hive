// Durable Colony job queue. HTTP/SSE, Discord, schedules, and webhooks enqueue
// work here; execution is detached from the initiating transport.
const os = require('os');
const db = require('../db');
const { logger } = require('./logger');
const { notifyRoster } = require('./rosterBus');

const OWNER = `${os.hostname()}:${process.pid}`;
const LEASE_SECONDS = 45;
const HEARTBEAT_MS = 15_000;
const MAX_CONCURRENT = Math.max(1, Number(process.env.HIVE_MAX_CONCURRENT_COLONY_RUNS) || 2);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.HIVE_MAX_COLONY_RUN_ATTEMPTS) || 3);
const active = new Map();
let draining = false;

function ensureJob(runId, teamId = null) {
  db.prepare(`INSERT OR IGNORE INTO colony_run_jobs (run_id, team_id, status) VALUES (?, ?, 'queued')`)
    .run(runId, teamId || null);
  return db.prepare('SELECT * FROM colony_run_jobs WHERE run_id=?').get(runId);
}

function enqueue(runId, teamId = null) {
  const existing = db.prepare('SELECT * FROM colony_run_jobs WHERE run_id=?').get(runId);
  if (existing && !['queued', 'running'].includes(existing.status)) {
    db.prepare(`UPDATE colony_run_jobs SET status='queued', lease_owner=NULL,
      lease_expires_at=NULL, finished_at=NULL, last_error=NULL, attempt=0, updated_at=unixepoch() WHERE run_id=?`).run(runId);
  } else {
    ensureJob(runId, teamId);
  }
  setImmediate(drain);
  return db.prepare('SELECT * FROM colony_run_jobs WHERE run_id=?').get(runId);
}

function claimNext() {
  const claim = db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    const exhausted = db.prepare(`SELECT run_id FROM colony_run_jobs
      WHERE status='running' AND COALESCE(lease_expires_at,0)<? AND attempt>=?`).all(now, MAX_ATTEMPTS);
    for (const item of exhausted) {
      db.prepare("UPDATE colony_run_jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL, finished_at=unixepoch(), last_error='Retry limit exceeded', updated_at=unixepoch() WHERE run_id=?").run(item.run_id);
      db.prepare("UPDATE colonies SET status='error', outcome='failed', completed_at=unixepoch(), updated_at=unixepoch() WHERE id=? AND status='running'").run(item.run_id);
    }
    const row = db.prepare(`SELECT * FROM colony_run_jobs
      WHERE attempt<? AND (status='queued' OR (status='running' AND COALESCE(lease_expires_at,0)<?))
      ORDER BY created_at ASC LIMIT 1`).get(MAX_ATTEMPTS, now);
    if (!row) return null;
    const changed = db.prepare(`UPDATE colony_run_jobs SET status='running', lease_owner=?,
      lease_expires_at=?, attempt=attempt+1, started_at=COALESCE(started_at,unixepoch()),
      updated_at=unixepoch() WHERE run_id=? AND
      attempt<? AND (status='queued' OR (status='running' AND COALESCE(lease_expires_at,0)<?))`)
      .run(OWNER, now + LEASE_SECONDS, row.run_id, MAX_ATTEMPTS, now);
    return changed.changes ? db.prepare('SELECT * FROM colony_run_jobs WHERE run_id=?').get(row.run_id) : null;
  });
  return claim.immediate();
}

function terminalJobStatus(runStatus) {
  if (runStatus === 'done') return 'succeeded';
  if (runStatus === 'stopped') return 'stopped';
  if (runStatus === 'blocked') return 'blocked';
  return 'failed';
}

function execute(job) {
  const { runColony } = require('./colonyRunner');
  const ac = new AbortController();
  const attempt = job.attempt;
  const heartbeat = setInterval(() => {
    try {
      const renewed = db.prepare(`UPDATE colony_run_jobs SET lease_expires_at=unixepoch()+?, updated_at=unixepoch()
        WHERE run_id=? AND status='running' AND lease_owner=? AND attempt=?`).run(LEASE_SECONDS, job.run_id, OWNER, attempt);
      if (!renewed.changes) {
        clearInterval(heartbeat);
        const current = db.prepare('SELECT status FROM colony_run_jobs WHERE run_id=?').get(job.run_id);
        if (current?.status !== 'stopped') {
          logger.error('colonyJobs', 'lease_lost', { runId: job.run_id, attempt });
        }
        ac.abort();
        return;
      }
      db.prepare('UPDATE colonies SET heartbeat_at=unixepoch() WHERE id=?').run(job.run_id);
    } catch { /* the runner remains authoritative; the next heartbeat can retry */ }
  }, HEARTBEAT_MS);
  active.set(job.run_id, { ac, heartbeat });
  db.prepare("UPDATE colonies SET status=CASE WHEN status='stopped' THEN status ELSE 'running' END, started_at=COALESCE(started_at,unixepoch()), heartbeat_at=unixepoch() WHERE id=?").run(job.run_id);
  notifyRoster('run_started', { run_id: job.run_id });

  Promise.resolve(runColony(job.run_id, null, ac.signal))
    .catch(error => {
      logger.error('colonyJobs', 'run_failed', { runId: job.run_id, error: error?.message || String(error) });
      db.prepare("UPDATE colonies SET status='error', outcome='failed', completed_at=unixepoch(), updated_at=unixepoch() WHERE id=? AND status='running'").run(job.run_id);
    })
    .finally(() => {
      clearInterval(heartbeat);
      active.delete(job.run_id);
      const row = db.prepare('SELECT status FROM colonies WHERE id=?').get(job.run_id);
      const status = terminalJobStatus(row?.status || 'error');
      db.prepare(`UPDATE colony_run_jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL,
        finished_at=unixepoch(), updated_at=unixepoch() WHERE run_id=? AND lease_owner=? AND attempt=?`).run(status, job.run_id, OWNER, attempt);
      db.prepare('UPDATE colonies SET completed_at=COALESCE(completed_at,unixepoch()) WHERE id=? AND status<>\'running\'').run(job.run_id);
      notifyRoster('run_finished', { run_id: job.run_id });
      setImmediate(drain);
    });
}

function drain() {
  if (draining) return;
  draining = true;
  try {
    while (active.size < MAX_CONCURRENT) {
      const job = claimNext();
      if (!job) break;
      execute(job);
    }
  } finally {
    draining = false;
  }
}

function stop(runId) {
  const live = active.get(runId);
  if (live) {
    clearInterval(live.heartbeat);
    live.ac.abort();
  }
  db.prepare(`UPDATE colony_run_jobs SET status='stopped', lease_owner=NULL,
    lease_expires_at=NULL, finished_at=unixepoch(), updated_at=unixepoch() WHERE run_id=?`).run(runId);
  db.prepare("UPDATE colonies SET status='stopped', outcome='stopped', completed_at=unixepoch(), updated_at=unixepoch() WHERE id=? AND status='running'").run(runId);
  return !!live;
}

function recover() {
  // A new process cannot own an old in-memory call stack. Requeue durable jobs;
  // run-scoped events, workflow nodes, histories, artifacts, and git state let the
  // new attempt continue with an explicit recovery context.
  db.prepare(`UPDATE colony_run_jobs SET status='queued', lease_owner=NULL,
    lease_expires_at=NULL, updated_at=unixepoch() WHERE status='running'`).run();
  const orphaned = db.prepare("SELECT id, team_id FROM colonies WHERE status='running'").all();
  for (const row of orphaned) ensureJob(row.id, row.team_id);
  setImmediate(drain);
  return orphaned.length;
}

function status(runId) {
  return db.prepare('SELECT * FROM colony_run_jobs WHERE run_id=?').get(runId) || null;
}

module.exports = { enqueue, ensureJob, drain, stop, recover, status, activeCount: () => active.size, MAX_ATTEMPTS };
