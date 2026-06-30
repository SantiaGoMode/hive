// logSwallowed — make intentionally-swallowed errors observable (issue #26).
//
// Convention for catch blocks in this codebase:
//   1. Noteworthy-but-non-fatal failures (DB writes, external calls, JSON
//      parses of persisted data, cleanup):
//        catch (e) { logSwallowed('component:action', e); }
//   2. Genuinely ignorable failures (abort() on a possibly-settled controller,
//      removeEventListener, probing loops where failure IS the answer):
//        keep `catch {}` but add a trailing comment explaining why, e.g.
//        catch {} /* abort is best-effort */
//   3. Anything that should surface to the caller: handle it properly —
//      don't swallow.
//
// Guarantees:
//   - Never throws (logging must not crash the original code path).
//   - Redacts obvious secrets (bearer tokens, sk-… keys, key/token/secret
//     key-value pairs) from messages and context.
//   - Rate-limits per context key: first hit in a 60s window logs, repeats
//     are counted and reported as "+N similar suppressed" in the next log.
//   - Set LOG_SWALLOWED=0 to silence entirely (e.g. in tests).

const WINDOW_MS = 60_000;
const stats = new Map(); // context -> { windowStart, suppressed }

const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,                                   // OpenAI/gateway-style keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,                         // bearer tokens
  /\b(api[_-]?key|token|secret|password|authorization)\b(\s*[=:]\s*)[^\s,;&"'}\]]+/gi, // k=v pairs
];

function redact(text) {
  let out = String(text);
  out = out.replace(REDACT_PATTERNS[0], '[redacted]');
  out = out.replace(REDACT_PATTERNS[1], 'Bearer [redacted]');
  out = out.replace(REDACT_PATTERNS[2], (_, key, sep) => `${key}${sep}[redacted]`);
  return out;
}

function serializeError(err) {
  if (err == null) return 'unknown error';
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); } /* circular refs */
}

function safeContext(extra) {
  try { return redact(JSON.stringify(extra)); } catch { return '[unserializable context]'; }
}

/**
 * Record an intentionally-swallowed error without ever throwing.
 * @param {string} context  stable "component:action" key, e.g. "colonyRunner:cleanup"
 * @param {unknown} err     the caught error (any shape)
 * @param {object} [extra]  small, secret-free context object (ids, names)
 */
function logSwallowed(context, err, extra) {
  try {
    if (process.env.LOG_SWALLOWED === '0') return;
    const now = Date.now();
    const s = stats.get(context);
    if (s && now - s.windowStart < WINDOW_MS) {
      s.suppressed++;
      return;
    }
    const suppressed = s ? s.suppressed : 0;
    stats.set(context, { windowStart: now, suppressed: 0 });
    const msg = redact(serializeError(err));
    const detail = extra && Object.keys(extra).length ? ` ${safeContext(extra)}` : '';
    const tail = suppressed > 0 ? ` (+${suppressed} similar suppressed)` : '';
    console.warn(`[swallowed] ${context}: ${msg}${detail}${tail}`);
  } catch {} /* logging must never crash the caller */
}

// Test hook: reset rate-limit windows between cases.
function _resetSwallowedStats() { stats.clear(); }

module.exports = { logSwallowed, _resetSwallowedStats, _redact: redact };
