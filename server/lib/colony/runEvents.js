// Durable append-only event stream for Colony runs. This is the sole replay and
// audit source and survives continuation, reconnects, and process restarts.
const db = require('../../db');

function safeParse(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function lastSequence(runId) {
  return db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM colony_run_events WHERE run_id=?').get(runId)?.seq || 0;
}

function appendRunEvent(runId, eventType, payload, seq = null) {
  const insert = db.transaction(() => {
    const next = seq == null ? lastSequence(runId) + 1 : Number(seq);
    db.prepare(`
      INSERT OR IGNORE INTO colony_run_events (run_id, seq, event_type, payload)
      VALUES (?, ?, ?, ?)
    `).run(runId, next, String(eventType || 'event'), JSON.stringify(payload || {}));
    return next;
  });
  return insert.immediate();
}

function listRunEvents(runId, { since = 0, limit = 5000, eventType = null } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 5000, 10000));
  const rows = eventType
    ? db.prepare('SELECT * FROM colony_run_events WHERE run_id=? AND seq>? AND event_type=? ORDER BY seq ASC LIMIT ?').all(runId, since, eventType, capped)
    : db.prepare('SELECT * FROM colony_run_events WHERE run_id=? AND seq>? ORDER BY seq ASC LIMIT ?').all(runId, since, capped);
  return rows.map(row => ({ ...row, payload: safeParse(row.payload, {}) }));
}

function listLogEntries(runId, { since = 0, limit = 5000 } = {}) {
  return listRunEvents(runId, { since, limit, eventType: 'log_entry' })
    .map(event => event.payload)
    .filter(entry => entry && typeof entry === 'object');
}

module.exports = { appendRunEvent, listLogEntries, listRunEvents, lastSequence };
