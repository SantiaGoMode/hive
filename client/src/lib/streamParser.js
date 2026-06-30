// Shared streaming-event parser (issue #5).
//
// Hive's server streams JSON events over `fetch` response bodies in an
// SSE-flavored line format: each event is a `data: {json}` line. The model-pull
// endpoints separate events with a blank line (`\n\n`); the pipeline and colony
// streams use a single `\n`. Either way, every `data:` line carries one complete
// JSON object — blank lines, `:` heartbeats/comments, and a trailing `[DONE]`
// sentinel are ignored. This module centralizes the read + line-buffer + parse
// loop that was duplicated across ModelBrowser, Dashboard, PipelinesPage, and
// ColonyPage, preserving partial-chunk buffering and abort behavior.
//
// Two layers:
//   createSSEParser() — pure, synchronous: feed decoded text chunks, get parsed
//     events back. No streams, so it's trivial to unit-test.
//   readSSEStream(response, { signal }) — async generator over a fetch Response,
//     built on the parser; yields parsed event objects.

// Pull one event out of a single line, if it carries one. Returns undefined for
// blank lines, comments/heartbeats, non-`data:` fields, the `[DONE]` sentinel,
// and malformed JSON (reported via onParseError but never thrown).
function lineToEvent(line, onParseError) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined; // blank / comment / heartbeat
  if (!trimmed.startsWith('data:')) return undefined;        // only data fields carry JSON
  const payload = trimmed.slice(5).trim();                   // strip 'data:' (+ optional space)
  if (!payload || payload === '[DONE]') return undefined;
  try {
    return JSON.parse(payload);
  } catch (err) {
    onParseError?.(err, payload);
    return undefined;
  }
}

/**
 * Incremental SSE-style parser. Push decoded text chunks; each push returns the
 * events that completed in that chunk. Call flush() at end-of-stream to parse a
 * final line that arrived without a trailing newline.
 * @param {{ onParseError?: (err: Error, payload: string) => void }} [opts]
 */
export function createSSEParser({ onParseError } = {}) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const events = [];
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const evt = lineToEvent(buf.slice(0, nl), onParseError);
        buf = buf.slice(nl + 1);
        if (evt !== undefined) events.push(evt);
      }
      return events;
    },
    flush() {
      if (!buf) return [];
      const evt = lineToEvent(buf, onParseError);
      buf = '';
      return evt === undefined ? [] : [evt];
    },
  };
}

/**
 * Async generator over a fetch Response's SSE-style body. Yields each parsed
 * `data:` JSON event. Stops promptly when `signal` aborts (also cancels the
 * underlying reader), and always releases the reader on exit.
 * @param {Response} response  a fetch Response with a readable body
 * @param {{ signal?: AbortSignal, onParseError?: (err: Error, payload: string) => void }} [opts]
 */
export async function* readSSEStream(response, { signal, onParseError } = {}) {
  if (!response?.body?.getReader) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser({ onParseError });
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      for (const evt of parser.push(decoder.decode(value, { stream: true }))) yield evt;
    }
    // Flush any bytes held by the decoder, then any final buffered line.
    const tail = decoder.decode();
    if (tail) for (const evt of parser.push(tail)) yield evt;
    for (const evt of parser.flush()) yield evt;
  } finally {
    try { await reader.cancel(); } catch { /* reader may already be closed */ }
  }
}
