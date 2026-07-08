// Roster-level change notifications. The colony roster (/colony) shows live
// status for every team; rather than a per-team bus, a single emitter carries
// coarse "something changed, refetch" hints: queue mutations, run starts, and
// run completions. Payloads are deliberately tiny — subscribers refetch the
// roster/queue endpoints instead of patching state from the event.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
// Every open roster page holds a listener; lift the default 10-listener warning.
bus.setMaxListeners(128);

function notifyRoster(reason, detail = {}) {
  bus.emit('roster', { type: 'roster_changed', reason, ...detail });
}

function onRoster(listener) {
  bus.on('roster', listener);
  return () => bus.off('roster', listener);
}

module.exports = { notifyRoster, onRoster };
