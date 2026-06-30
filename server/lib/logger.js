// Small leveled structured logger + in-memory ring buffer (issue #31).
//
// Goals: consistent, level-aware log lines with a component + event + optional
// metadata, and a bounded ring buffer of recent warnings/errors that the
// /api/system/metrics endpoint (and the #7 dashboard) can read without scraping
// console text. Never throws — logging must not crash a caller. Secrets are
// redacted from messages and metadata.
//
// Console verbosity is controlled by LOG_LEVEL (debug|info|warn|error|silent;
// default info). The ring buffer ALWAYS records warn/error regardless of
// LOG_LEVEL, so operational visibility doesn't depend on console verbosity.

const crypto = require('crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const RING_MAX = 100;

function consoleThreshold() {
  return LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
}

const ring = []; // recent { ts, level, component, event, meta } (warn/error), capped

// ── Redaction (self-contained so logSwallowed can feed us without an import cycle)
const REDACT = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\b(api[_-]?key|token|secret|password|authorization)\b(\s*[=:]\s*)[^\s,;&"'}\]]+/gi, (_, k, sep) => `${k}${sep}[redacted]`],
];
function redact(text) {
  let out = String(text);
  for (const [re, rep] of REDACT) out = out.replace(re, rep);
  return out;
}

// Circular-safe, secret-redacted serialization of a metadata object.
function safeMeta(meta) {
  if (meta == null) return undefined;
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(meta, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      return value;
    });
    return json === undefined ? undefined : JSON.parse(redact(json));
  } catch {
    return { _meta: 'unserializable' };
  }
}

function emit(level, component, event, meta) {
  try {
    const entry = { ts: Date.now(), level, component: String(component || ''), event: String(event || ''), meta: safeMeta(meta) };
    if (level === 'warn' || level === 'error') {
      ring.push(entry);
      if (ring.length > RING_MAX) ring.shift();
    }
    if ((LEVELS[level] ?? LEVELS.info) >= consoleThreshold() && consoleThreshold() < LEVELS.silent) {
      const line = `[${level}] ${entry.component}: ${entry.event}`;
      const tail = entry.meta && Object.keys(entry.meta).length ? ` ${redact(JSON.stringify(entry.meta))}` : '';
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink(line + tail);
    }
  } catch { /* logging must never crash the caller */ }
}

const logger = {
  debug: (component, event, meta) => emit('debug', component, event, meta),
  info:  (component, event, meta) => emit('info', component, event, meta),
  warn:  (component, event, meta) => emit('warn', component, event, meta),
  error: (component, event, meta) => emit('error', component, event, meta),
};

// Record an intentionally-swallowed error into the ring buffer WITHOUT printing
// (logSwallowed already console.warns). Lets swallowed errors surface in
// /api/system/metrics. Never throws.
function noteSwallowed(context, message, extra) {
  try {
    ring.push({ ts: Date.now(), level: 'warn', component: 'swallowed', event: redact(String(context || '')), meta: safeMeta({ message: redact(String(message ?? '')), ...(extra || {}) }) });
    if (ring.length > RING_MAX) ring.shift();
  } catch { /* never throw */ }
}

// Short correlation id for request/run logging.
function newRequestId() {
  return crypto.randomUUID().slice(0, 8);
}

// Recent warnings/errors (newest last), capped at RING_MAX. Returns a copy.
function getRecentLogs(limit = RING_MAX) {
  const n = Math.max(0, Math.min(limit, ring.length));
  return ring.slice(ring.length - n);
}

// Test hook.
function _resetLogs() { ring.length = 0; }

module.exports = { logger, noteSwallowed, getRecentLogs, newRequestId, _resetLogs, _redact: redact, RING_MAX };
