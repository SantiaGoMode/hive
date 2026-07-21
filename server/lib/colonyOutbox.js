// Idempotent external side effects. Workflow tools enqueue intent; finalization
// performs it only after the server has accepted the run outcome.
const db = require('../db');
const { updateGitHubIssue, detectGitHubRepo } = require('./githubBoard');
const { logger } = require('./logger');

const MAX_ATTEMPTS = Math.max(1, Number(process.env.HIVE_OUTBOX_MAX_ATTEMPTS) || 5);
const POLL_MS = Math.max(1_000, Number(process.env.HIVE_OUTBOX_POLL_MS) || 10_000);
let timer = null;
let draining = false;

function id() { return `out_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

function enqueue(runId, actionType, idempotencyKey, payload) {
  db.prepare(`INSERT OR IGNORE INTO colony_outbox (id, run_id, action_type, idempotency_key, payload)
    VALUES (?, ?, ?, ?, ?)`).run(id(), runId, actionType, idempotencyKey, JSON.stringify(payload || {}));
}

async function processRun(runId) {
  const pending = db.prepare("SELECT * FROM colony_outbox WHERE run_id=? AND status IN ('pending','failed') AND attempt_count<? AND COALESCE(next_attempt_at,0)<=unixepoch() ORDER BY created_at ASC").all(runId, MAX_ATTEMPTS);
  const results = [];
  for (const item of pending) {
    const claimed = db.prepare("UPDATE colony_outbox SET status='processing', updated_at=unixepoch() WHERE id=? AND status IN ('pending','failed')").run(item.id);
    if (!claimed.changes) continue;
    let payload = {};
    try { payload = JSON.parse(item.payload || '{}'); } catch {}
    try {
      if (item.action_type === 'close_issue') {
        const repo = detectGitHubRepo(payload.repo_path);
        if (!repo) throw new Error('No GitHub remote found for queued issue close');
        await updateGitHubIssue({ owner: repo.owner, repo: repo.repo, number: payload.issue_number, state: 'closed', comment: payload.comment || '' });
      } else {
        throw new Error(`Unknown colony outbox action: ${item.action_type}`);
      }
      db.prepare("UPDATE colony_outbox SET status='completed', completed_at=unixepoch(), updated_at=unixepoch(), last_error=NULL, next_attempt_at=NULL WHERE id=?").run(item.id);
      results.push({ id: item.id, ok: true });
    } catch (error) {
      const attempts = item.attempt_count + 1;
      const status = attempts >= MAX_ATTEMPTS ? 'dead_letter' : 'failed';
      const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10) * 5);
      db.prepare("UPDATE colony_outbox SET status=?, attempt_count=?, last_error=?, next_attempt_at=unixepoch()+?, updated_at=unixepoch() WHERE id=?")
        .run(status, attempts, error.message, delaySeconds, item.id);
      results.push({ id: item.id, ok: false, error: error.message });
    }
  }
  return results;
}

async function drain() {
  if (draining) return [];
  draining = true;
  try {
    // A process crash can leave a claimed item behind. External mutations use
    // stable idempotency keys, so make it retryable and preserve at-least-once semantics.
    db.prepare("UPDATE colony_outbox SET status='failed', next_attempt_at=unixepoch() WHERE status='processing' AND updated_at<unixepoch()-60").run();
    const runs = db.prepare("SELECT DISTINCT run_id FROM colony_outbox WHERE status IN ('pending','failed') AND attempt_count<? AND COALESCE(next_attempt_at,0)<=unixepoch() ORDER BY created_at ASC LIMIT 20").all(MAX_ATTEMPTS);
    const results = [];
    for (const row of runs) results.push(...await processRun(row.run_id));
    return results;
  } finally {
    draining = false;
  }
}

function start() {
  if (timer) return;
  drain().catch(error => logger.error('colonyOutbox', 'drain_failed', { error: error.message }));
  timer = setInterval(() => {
    drain().catch(error => logger.error('colonyOutbox', 'drain_failed', { error: error.message }));
  }, POLL_MS);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { enqueue, processRun, drain, start, stop, MAX_ATTEMPTS };
