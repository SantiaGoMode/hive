// Per-colony event bus. runColony publishes events ('log_entry', 'agent_ready',
// 'token', 'thinking', 'round_start', 'orchestrator_message', 'done', 'error',
// 'ws', ...) to a named EventEmitter. SSE route handlers subscribe as listeners.
//
// This lets multiple clients (e.g., the original POST launcher plus a second
// browser tab that opens GET /api/colony/:id/stream to resume) watch the same
// run simultaneously, and lets a client that refreshes the page reattach to a
// live run instead of seeing a frozen DB snapshot.
//
// Buses are created lazily and cleaned up when a run ends (and no listeners
// remain).

const { EventEmitter } = require('events');

const buses = new Map(); // colonyId -> EventEmitter

function getBus(colonyId) {
  let bus = buses.get(colonyId);
  if (!bus) {
    bus = new EventEmitter();
    // A single colony could have the POST launcher + several GET /stream clients
    // tailing at once. Lift the default 10-listener warning.
    bus.setMaxListeners(64);
    buses.set(colonyId, bus);
  }
  return bus;
}

function hasBus(colonyId) {
  return buses.has(colonyId);
}

function publish(colonyId, event) {
  const bus = buses.get(colonyId);
  if (bus) bus.emit('event', event);
  // Terminal run events also nudge the roster page (every launch path
  // publishes its end through this bus, so this is the one chokepoint).
  if (event?.type === 'done' || event?.type === 'error') {
    try { require('./rosterBus').notifyRoster('run_finished', { run_id: colonyId }); } catch { /* roster is best-effort */ }
  }
}

// Call after a run ends. If there are still subscribers (e.g., a tailing client
// that will disconnect on its own after receiving 'done'), let them finish —
// they'll be cleaned up by the listener-count check on their disconnect.
function maybeCleanup(colonyId) {
  const bus = buses.get(colonyId);
  if (!bus) return;
  if (bus.listenerCount('event') === 0) {
    buses.delete(colonyId);
  }
}

// Listener-count cleanup relies on every socket emitting 'close'; one that
// never does leaks the bus forever. Sweep buses whose colony has reached a
// terminal status — anything still subscribed is tailing a finished run.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function sweepTerminalBuses() {
  if (buses.size === 0) return 0;
  let removed = 0;
  try {
    const db = require('../db'); // lazy: avoid a load-order dependency on db
    for (const colonyId of [...buses.keys()]) {
      const row = db.prepare('SELECT status FROM colonies WHERE id = ?').get(colonyId);
      if (!row || row.status !== 'running') {
        buses.delete(colonyId);
        removed++;
      }
    }
  } catch { /* db unavailable (tests) — retry next sweep */ }
  return removed;
}

const sweepTimer = setInterval(sweepTerminalBuses, SWEEP_INTERVAL_MS);
sweepTimer.unref?.(); // don't hold the process open for the sweep

module.exports = { getBus, hasBus, publish, maybeCleanup, sweepTerminalBuses };
