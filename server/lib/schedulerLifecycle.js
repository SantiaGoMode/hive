const { logger } = require('./logger');

const services = new Map();

function now() {
  return Date.now();
}

function iso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}

function serializeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

function ensureState(name) {
  if (!services.has(name)) {
    services.set(name, {
      name,
      start: null,
      stop: null,
      status: null,
      running: false,
      start_count: 0,
      stop_count: 0,
      tick_count: 0,
      last_started_ms: null,
      last_stopped_ms: null,
      last_tick_ms: null,
      last_error: null,
      last_error_ms: null,
      last_meta: null,
    });
  }
  return services.get(name);
}

function register(name, hooks = {}) {
  const state = ensureState(name);
  state.start = typeof hooks.start === 'function' ? hooks.start : state.start;
  state.stop = typeof hooks.stop === 'function' ? hooks.stop : state.stop;
  state.status = typeof hooks.status === 'function' ? hooks.status : state.status;
  return status(name);
}

function markStarted(name, meta = null) {
  const state = ensureState(name);
  state.running = true;
  state.start_count += 1;
  state.last_started_ms = now();
  state.last_error = null;
  state.last_error_ms = null;
  state.last_meta = meta;
  return status(name);
}

function markStopped(name, meta = null) {
  const state = ensureState(name);
  state.running = false;
  state.stop_count += 1;
  state.last_stopped_ms = now();
  state.last_meta = meta;
  return status(name);
}

function heartbeat(name, meta = null) {
  const state = ensureState(name);
  state.tick_count += 1;
  state.last_tick_ms = now();
  state.last_meta = meta;
  return status(name);
}

function recordError(name, error) {
  const state = ensureState(name);
  state.last_error = serializeError(error);
  state.last_error_ms = now();
  logger.warn('scheduler_lifecycle', 'service_error', { service: name, error: state.last_error });
  return status(name);
}

function start(name) {
  const state = ensureState(name);
  if (state.running) return status(name);
  try {
    const result = state.start ? state.start() : undefined;
    markStarted(name);
    return result;
  } catch (error) {
    recordError(name, error);
    throw error;
  }
}

function stop(name) {
  const state = ensureState(name);
  if (!state.running) return status(name);
  try {
    const result = state.stop ? state.stop() : undefined;
    markStopped(name);
    return result;
  } catch (error) {
    recordError(name, error);
    throw error;
  }
}

function startAll(names = Array.from(services.keys())) {
  const results = {};
  for (const name of names) {
    try {
      start(name);
      results[name] = status(name);
    } catch (error) {
      results[name] = { ...status(name), start_failed: true, error: serializeError(error) };
    }
  }
  return results;
}

function stopAll(names = Array.from(services.keys())) {
  const results = {};
  for (const name of names) {
    try {
      stop(name);
      results[name] = status(name);
    } catch (error) {
      results[name] = { ...status(name), stop_failed: true, error: serializeError(error) };
    }
  }
  return results;
}

function status(name) {
  const state = ensureState(name);
  let serviceStatus = {};
  try {
    serviceStatus = state.status ? (state.status() || {}) : {};
  } catch (error) {
    serviceStatus = { status_error: serializeError(error) };
  }
  return {
    name,
    running: state.running,
    start_count: state.start_count,
    stop_count: state.stop_count,
    tick_count: state.tick_count,
    last_started_at: iso(state.last_started_ms),
    last_stopped_at: iso(state.last_stopped_ms),
    last_tick_at: iso(state.last_tick_ms),
    last_error: state.last_error,
    last_error_at: iso(state.last_error_ms),
    last_meta: state.last_meta,
    ...serviceStatus,
  };
}

function statuses() {
  return Object.fromEntries(Array.from(services.keys()).map(name => [name, status(name)]));
}

function _resetForTests() {
  services.clear();
}

module.exports = {
  register,
  start,
  stop,
  startAll,
  stopAll,
  heartbeat,
  markStarted,
  markStopped,
  recordError,
  status,
  statuses,
  _resetForTests,
};
