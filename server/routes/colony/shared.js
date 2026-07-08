// Shared state and helpers for the colony route modules.
//
// routes/colony.js was split into focused modules under this directory. They all
// register handlers on the SAME express router (see ./index.js), so the mounted
// path (/api/colony) and route declaration order are preserved exactly. This
// module holds the cross-cutting pieces those handlers share: the process-global
// active-run registry, SSE plumbing, repo-path settings, and small helpers.
const fs = require('fs');
const protocol = require('../../lib/colonyProtocol');
const db = require('../../db');
const { getBus, maybeCleanup } = require('../../lib/colonyBus');
const { logSwallowed } = require('../../lib/logSwallowed');
const { notifyRoster } = require('../../lib/rosterBus');

// Resolve a colony's seeded agents back to their protocol role keys by matching
// each agent's persona_role to the role metadata for the colony's recipe. Used
// to attach live agent_ids to the A2A ID cards.
function roleKeyForAgent(recipeId, agent) {
  if (!protocol.getFlow(recipeId) || !agent) return null;
  for (const [key, m] of Object.entries(protocol.DEV_TEAM_ROLES)) {
    if (m.role === agent.persona_role || m.name === agent.name) return key;
  }
  return null;
}

// "owner/repo" → { owner, repo } for write-back when no local repo path is set.
function parseRepoSlug(slug) {
  const m = String(slug || '').match(/^([^/]+)\/(.+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Active AbortControllers keyed by colonyId. This map is process-global for all
// run routes (start, stop, delete, bootstrap accept) so it must be shared across
// the route modules rather than re-created per module.
const activeRuns = new Map();

// Wall-clock safety cap. Now enforced inside runColony (so every launch path is
// covered, not just POST); re-exported here from the single source for any route
// that still references it.
const { COLONY_MAX_DURATION_MS, runColony } = require('../../lib/colonyRunner');

// SSE plumbing shared between POST / and GET /:id/stream.
function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering if any
  res.flushHeaders();
}

function sseWrite(res, data) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// Run a freshly created colony and stream its events to this response as SSE.
// Shared by the two operator launch paths — POST /api/colony (legacy/direct)
// and POST /api/colony/teams/:tid/queue/:itemId/start (queue Start step) — so
// the abort/bus/status handling can't drift between them.
async function runAndStreamColony(res, colonyId) {
  sseHeaders(res);
  const emit = (data) => sseWrite(res, data);
  emit({ type: 'colony_id', colonyId });

  const ac = new AbortController();
  activeRuns.set(colonyId, ac);
  notifyRoster('run_started', { run_id: colonyId });

  // Wall-clock timeout is enforced inside runColony (covers every launch path),
  // so this route runs no timer of its own.

  // Subscribe this client to the per-colony bus. runColony publishes every
  // event to the bus, so this listener sees the full stream; the seq guard
  // drops duplicate log_entry replays.
  const bus = getBus(colonyId);
  let lastSeqSent = 0;
  const listener = (event) => {
    if (event.type === 'log_entry' && event.entry?.seq && event.entry.seq <= lastSeqSent) {
      return;
    }
    if (event.type === 'log_entry' && event.entry?.seq > lastSeqSent) {
      lastSeqSent = event.entry.seq;
    }
    emit(event);
  };
  bus.on('event', listener);

  // Use res.on('close') — NOT req.on('close'). In Express 5 / Node HTTP, req 'close'
  // fires as soon as the request body has been fully read (almost immediately for a
  // small POST), which would falsely abort every run the instant it starts. res 'close'
  // only fires when the response stream ends or the client actually disconnects.
  res.on('close', () => {
    if (!res.writableFinished) {
      ac.abort();
    }
    bus.off('event', listener);
    activeRuns.delete(colonyId);
    maybeCleanup(colonyId);
  });

  try {
    await runColony(colonyId, null, ac.signal);
  } catch (e) {
    // Safety net: runColony should handle its own errors internally, but if anything
    // escapes (early throw before its try/catch, etc.), we must update the DB status
    // so the colony doesn't stay stuck at 'running' forever.
    const isAbort = e.name === 'AbortError' || ac.signal.aborted || e.message === 'Colony run was stopped';
    const finalStatus = isAbort ? 'stopped' : 'error';
    try {
      db.prepare('UPDATE colonies SET status=?, updated_at=unixepoch() WHERE id=?').run(finalStatus, colonyId);
    } catch (e2) { logSwallowed('colonyRoutes:persistStatus', e2, { colonyId }); }
    emit({ type: isAbort ? 'done' : 'error', status: finalStatus, message: e.message });
  } finally {
    bus.off('event', listener);
    activeRuns.delete(colonyId);
    maybeCleanup(colonyId);
    notifyRoster('run_finished', { run_id: colonyId });
    if (!res.writableEnded) res.end();
  }
}

function getColonyRepoPath() {
  return db.prepare("SELECT value FROM app_settings WHERE key='colony_repo_path'").get()?.value || '';
}

function setColonyRepoPath(repoPath) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('colony_repo_path', repoPath);
}

module.exports = {
  fs,
  roleKeyForAgent,
  parseRepoSlug,
  activeRuns,
  COLONY_MAX_DURATION_MS,
  sseHeaders,
  sseWrite,
  runAndStreamColony,
  getColonyRepoPath,
  setColonyRepoPath,
};
