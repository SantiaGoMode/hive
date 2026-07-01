// Log-entry truncation for colony event streams.
// Caps were 500/2000/300 which visibly chopped worker responses (ask_agent
// results) to 300 chars in the UI — "cuts things off". The DB log keeps at most
// LOG_MAX_ENTRIES, so roomier caps are safe.

function truncateArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > 1500 ? v.slice(0, 1500) + '…' : v;
  }
  return out;
}

function truncateResult(result) {
  if (result === null || result === undefined) return result;
  const str = JSON.stringify(result);
  if (str.length <= 8000) return result;
  if (typeof result === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(result)) {
      // `response` carries the worker's full answer — keep the most of it.
      const cap = k === 'response' ? 6000 : 1000;
      out[k] = typeof v === 'string' && v.length > cap ? v.slice(0, cap) + '…' : v;
    }
    return out;
  }
  return String(result).slice(0, 8000) + '…';
}

module.exports = { truncateArgs, truncateResult };
