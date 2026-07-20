// ── Colony work items ─────────────────────────────────────────────────────────
// The per-colony work queue (colonies-first spec, R3). Work reaches a colony as
// an item — from the board, a webhook, a schedule, or the operator — and moves
// proposed → queued → claimed → done. A claimed item points at the run it
// became (run_id → colonies.id). team_id NULL = the roster's Unrouted tray.

const db = require('../db');
const { notifyRoster } = require('./rosterBus');

const SOURCES = new Set(['board', 'webhook', 'schedule', 'manual']);
const STATUSES = new Set(['proposed', 'queued', 'claimed', 'done', 'dismissed']);
// Items still waiting for (or doing) work — everything except done/dismissed.
const OPEN_STATUSES = ['proposed', 'queued', 'claimed'];

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeParse(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    team_id: row.team_id || null,
    source: row.source,
    source_ref: row.source_ref || null,
    title: row.title || '',
    direction: row.direction || '',
    board_card: safeParse(row.board_card, null),
    status: row.status,
    run_id: row.run_id || null,
    match_reason: row.match_reason || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createWorkItem({ teamId = null, source = 'manual', sourceRef = null, title = '', direction = '', boardCard = null, status = 'queued', matchReason = '' } = {}) {
  if (!SOURCES.has(source)) throw new Error('unknown source');
  if (!STATUSES.has(status)) throw new Error('unknown status');
  const trimmedTitle = String(title || '').trim() || (boardCard?.title ? String(boardCard.title) : '');
  const trimmedDirection = String(direction || '').trim();
  if (!trimmedTitle && !trimmedDirection) throw new Error('A work item needs a title or a direction');
  const id = newId();
  db.prepare(`
    INSERT INTO colony_work_items (id, team_id, source, source_ref, title, direction, board_card, status, match_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, teamId || null, source, sourceRef || null,
    trimmedTitle || trimmedDirection.split('\n')[0].slice(0, 120),
    trimmedDirection, boardCard ? JSON.stringify(boardCard) : null, status, String(matchReason || ''),
  );
  notifyRoster('work_item_created', { team_id: teamId || null });
  return getWorkItem(id);
}

function getWorkItem(id) {
  return rowToItem(db.prepare('SELECT * FROM colony_work_items WHERE id=?').get(id));
}

// Claimed items track their run lazily: whenever a queue is read, items whose
// run reached a terminal status flip to done, and items whose run row vanished
// (run deleted) fall back to queued. This keeps the queue truthful without
// threading queue updates through every run-completion path in the runner.
function reconcileClaimedItems() {
  db.prepare(`
    UPDATE colony_work_items SET status='done', updated_at=unixepoch()
    WHERE status='claimed' AND run_id IN (SELECT id FROM colonies WHERE status='done')
  `).run();
  db.prepare(`
    UPDATE colony_work_items SET status='queued', run_id=NULL, updated_at=unixepoch()
    WHERE status='claimed' AND run_id IN (SELECT id FROM colonies WHERE status IN ('stopped','error','blocked','failed'))
  `).run();
  db.prepare(`
    UPDATE colony_work_items SET status='queued', run_id=NULL, updated_at=unixepoch()
    WHERE status='claimed' AND run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM colonies)
  `).run();
}

function listWorkItems(teamId, { statuses = null, includeClosed = false } = {}) {
  reconcileClaimedItems();
  const wanted = Array.isArray(statuses) && statuses.length ? statuses : (includeClosed ? [...STATUSES] : OPEN_STATUSES);
  const marks = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM colony_work_items WHERE team_id=? AND status IN (${marks}) ORDER BY created_at ASC`,
  ).all(teamId, ...wanted).map(rowToItem);
}

// The roster's Unrouted tray: items no colony owns yet (or released by a
// deleted colony). Never includes done/dismissed — those are history.
function listUnroutedItems() {
  reconcileClaimedItems();
  return db.prepare(`
    SELECT * FROM colony_work_items WHERE team_id IS NULL AND status IN ('proposed','queued')
    ORDER BY created_at ASC
  `).all().map(rowToItem);
}

function updateWorkItem(id, data = {}) {
  const existing = getWorkItem(id);
  if (!existing) return null;
  const patch = {};
  if (data.title !== undefined) patch.title = String(data.title || '').trim();
  if (data.direction !== undefined) patch.direction = String(data.direction || '');
  if (data.status !== undefined) {
    if (!STATUSES.has(data.status)) throw new Error('unknown status');
    patch.status = data.status;
  }
  if (data.team_id !== undefined) {
    // Reroute: preserve routing history on the item itself (R8 groundwork).
    patch.team_id = data.team_id || null;
    if (data.team_id && data.team_id !== existing.team_id) {
      patch.match_reason = [existing.match_reason, `rerouted by operator`].filter(Boolean).join(' · ');
    }
  }
  if (data.match_reason !== undefined) patch.match_reason = String(data.match_reason || '');
  const keys = Object.keys(patch);
  if (!keys.length) return existing;
  db.prepare(`UPDATE colony_work_items SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=unixepoch() WHERE id=?`)
    .run(...keys.map(k => patch[k]), id);
  notifyRoster('work_item_updated', { team_id: existing.team_id });
  return getWorkItem(id);
}

function deleteWorkItem(id) {
  const existing = getWorkItem(id);
  db.prepare('DELETE FROM colony_work_items WHERE id=?').run(id);
  if (existing) notifyRoster('work_item_deleted', { team_id: existing.team_id });
}

// Bind an item to the run it became. Called by the queue start route right
// after createColony; the run's board_card is sourced from this item.
function claimWorkItem(id, runId, direction) {
  db.prepare(`
    UPDATE colony_work_items SET status='claimed', run_id=?, direction=COALESCE(?, direction), updated_at=unixepoch()
    WHERE id=?
  `).run(runId, direction !== undefined ? String(direction || '') : null, id);
  notifyRoster('work_item_claimed');
  return getWorkItem(id);
}

// Deleting a colony releases (not deletes) its open items back to Unrouted —
// work survives team changes. Claimed items lose their run binding (the runs
// are deleted with the team) and rejoin the tray as plain queued items.
function releaseTeamItems(teamId) {
  const info = db.prepare(`
    UPDATE colony_work_items
    SET team_id=NULL,
        run_id=CASE WHEN status='claimed' THEN NULL ELSE run_id END,
        status=CASE WHEN status='claimed' THEN 'queued' ELSE status END,
        updated_at=unixepoch()
    WHERE team_id=? AND status NOT IN ('done','dismissed')
  `).run(teamId);
  if (info.changes > 0) notifyRoster('team_items_released', { team_id: teamId });
  return info.changes;
}

// Run deleted individually → its claimed item goes back to queued.
function releaseRunItems(runId) {
  const info = db.prepare(`
    UPDATE colony_work_items SET status='queued', run_id=NULL, updated_at=unixepoch()
    WHERE run_id=? AND status='claimed'
  `).run(runId);
  if (info.changes > 0) notifyRoster('run_items_released');
  return info.changes;
}

// Queue depth for the roster: work waiting on the operator or in flight.
function queueCountsForTeam(teamId) {
  reconcileClaimedItems();
  const rows = db.prepare(
    "SELECT status, COUNT(*) AS n FROM colony_work_items WHERE team_id=? AND status IN ('proposed','queued','claimed') GROUP BY status",
  ).all(teamId);
  const counts = { proposed: 0, queued: 0, claimed: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return { ...counts, depth: counts.proposed + counts.queued };
}

// Intake dedupe: an event/card already represented by any item (open or
// resolved) must not be re-proposed — a dismissed proposal stays dismissed.
function hasItemForSource(source, sourceRef) {
  if (!sourceRef) return false;
  return !!db.prepare('SELECT 1 FROM colony_work_items WHERE source=? AND source_ref=? LIMIT 1').get(source, sourceRef);
}

module.exports = {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  listUnroutedItems,
  updateWorkItem,
  deleteWorkItem,
  claimWorkItem,
  releaseTeamItems,
  releaseRunItems,
  queueCountsForTeam,
  hasItemForSource,
  reconcileClaimedItems,
  OPEN_STATUSES,
};
