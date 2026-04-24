const express = require('express');
const router  = express.Router();
const { runColony, createColony, listColonies, getColony, deleteColony } = require('../lib/colonyRunner');
const { getBus, hasBus, maybeCleanup } = require('../lib/colonyBus');
const db = require('../db');

// Active AbortControllers keyed by colonyId
const activeRuns = new Map();

// Wall-clock safety cap. If a colony run hasn't finished in this many ms, we
// abort it. Prevents a stuck model or a worker agent in an infinite tool loop
// from pinning resources forever. Tuned generously — real runs with thinking
// models and multiple workers can take several minutes.
const COLONY_MAX_DURATION_MS = 15 * 60 * 1000; // 15 minutes

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

// GET /api/colony
router.get('/', (req, res) => {
  res.json(listColonies());
});

// GET /api/colony/:id
router.get('/:id', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  res.json(colony);
});

// GET /api/colony/:id/stream — resumable SSE tail.
// Replays log entries from the DB with seq > ?since= (default 0), then
// attaches to the per-colony event bus for live updates if the run is still
// ongoing. Safe to open from multiple tabs at once and safe to reopen after
// a browser refresh.
router.get('/:id/stream', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });

  sseHeaders(res);
  sseWrite(res, { type: 'colony_id', colonyId: colony.id });

  const since = parseInt(req.query.since || '0', 10) || 0;

  // Replay historical entries (already persisted).
  let lastSentSeq = since;
  const historical = Array.isArray(colony.log) ? colony.log : [];
  for (const entry of historical) {
    const seq = entry.seq || 0;
    if (seq > since) {
      sseWrite(res, { type: 'log_entry', entry });
      if (seq > lastSentSeq) lastSentSeq = seq;
    }
  }

  // Also replay agent_ready-style synthetic events for each historical agent_ready
  // log entry so the client color map / filter chips work without extra parsing.
  for (const entry of historical) {
    if (entry.kind === 'agent_ready' && entry.agent) {
      sseWrite(res, { type: 'agent_ready', role: entry.role, agent: entry.agent });
    }
  }

  // If the run is no longer active, close immediately.
  if (colony.status !== 'running' || !hasBus(colony.id)) {
    sseWrite(res, { type: 'done', status: colony.status });
    res.end();
    return;
  }

  // Otherwise attach to the live bus. Filter out log_entry events we've already
  // sent historically, so clients don't see duplicates across the handoff.
  const bus = getBus(colony.id);
  const listener = (event) => {
    if (event.type === 'log_entry' && event.entry?.seq && event.entry.seq <= lastSentSeq) {
      return;
    }
    if (event.type === 'log_entry' && event.entry?.seq > lastSentSeq) {
      lastSentSeq = event.entry.seq;
    }
    sseWrite(res, event);
  };
  bus.on('event', listener);

  res.on('close', () => {
    bus.off('event', listener);
    maybeCleanup(colony.id);
  });
});

// POST /api/colony — create + immediately stream via SSE
router.post('/', async (req, res) => {
  const { goal, model } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
  if (!model?.trim()) return res.status(400).json({ error: 'model is required' });

  const colonyId = createColony(goal.trim(), model.trim());

  sseHeaders(res);

  const emit = (data) => sseWrite(res, data);

  emit({ type: 'colony_id', colonyId });

  const ac = new AbortController();
  activeRuns.set(colonyId, ac);

  // Wall-clock timeout — abort the run if it exceeds COLONY_MAX_DURATION_MS.
  // Cleared in the finally block. We also emit a synthetic log line via the
  // bus so the UI can show why the run stopped.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try { ac.abort(); } catch {}
  }, COLONY_MAX_DURATION_MS);

  // Subscribe this POST client to the per-colony bus. runColony publishes
  // every event to the bus as well as calling the legacy onEvent callback,
  // so we can drop the onEvent path here once every caller migrates. For now
  // we keep it for safety. (The bus listener sees all events; onEvent is no-op
  // to avoid duplicates.)
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
    } catch {}
    const message = timedOut
      ? `Colony exceeded wall-clock limit of ${Math.round(COLONY_MAX_DURATION_MS / 60000)} minutes and was aborted`
      : e.message;
    emit({ type: isAbort ? 'done' : 'error', status: finalStatus, message });
  } finally {
    clearTimeout(timeoutHandle);
    bus.off('event', listener);
    activeRuns.delete(colonyId);
    maybeCleanup(colonyId);
    if (!res.writableEnded) res.end();
  }
});

// POST /api/colony/:id/stop
router.post('/:id/stop', (req, res) => {
  const ac = activeRuns.get(req.params.id);
  if (ac) {
    ac.abort();
    activeRuns.delete(req.params.id);
    res.json({ success: true, stopped: true });
  } else {
    res.json({ success: true, stopped: false, message: 'Not running' });
  }
});

// DELETE /api/colony/:id
router.delete('/:id', (req, res) => {
  const ac = activeRuns.get(req.params.id);
  if (ac) { ac.abort(); activeRuns.delete(req.params.id); }
  try {
    deleteColony(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
