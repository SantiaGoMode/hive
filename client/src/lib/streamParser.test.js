import { describe, it, expect, vi } from 'vitest';
import { createSSEParser, readSSEStream } from './streamParser';

// ── createSSEParser (pure) ─────────────────────────────────────────────────────

describe('createSSEParser', () => {
  it('parses one event per data: line (single \\n delimiter — pipeline/colony style)', () => {
    const p = createSSEParser();
    const out = p.push('data: {"type":"a"}\ndata: {"type":"b"}\n');
    expect(out).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('handles blank-line (\\n\\n) separated events — model-pull style', () => {
    const p = createSSEParser();
    expect(p.push('data: {"status":"pulling"}\n\ndata: {"status":"done"}\n\n'))
      .toEqual([{ status: 'pulling' }, { status: 'done' }]);
  });

  it('accepts both "data:" and "data: " prefixes', () => {
    const p = createSSEParser();
    expect(p.push('data:{"a":1}\ndata: {"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('buffers a line split across chunks until it completes', () => {
    const p = createSSEParser();
    expect(p.push('data: {"ty')).toEqual([]);            // incomplete: nothing yet
    expect(p.push('pe":"x"}\n')).toEqual([{ type: 'x' }]); // completes on next chunk
  });

  it('skips comments/heartbeats and the [DONE] sentinel', () => {
    const p = createSSEParser();
    const out = p.push(': keep-alive\ndata: {"n":1}\ndata: [DONE]\n\n');
    expect(out).toEqual([{ n: 1 }]);
  });

  it('reports malformed JSON via onParseError and keeps going (never throws)', () => {
    const onParseError = vi.fn();
    const p = createSSEParser({ onParseError });
    const out = p.push('data: {bad json}\ndata: {"ok":true}\n');
    expect(out).toEqual([{ ok: true }]);
    expect(onParseError).toHaveBeenCalledOnce();
    expect(onParseError.mock.calls[0][1]).toBe('{bad json}'); // the offending payload
  });

  it('flush() parses a final line with no trailing newline', () => {
    const p = createSSEParser();
    expect(p.push('data: {"first":1}\ndata: {"last":2}')).toEqual([{ first: 1 }]);
    expect(p.flush()).toEqual([{ last: 2 }]);
    expect(p.flush()).toEqual([]); // idempotent once drained
  });
});

// ── readSSEStream (over a fetch Response) ───────────────────────────────────────

function fakeResponse(chunks, { onCancel } = {}) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    body: {
      getReader() {
        return {
          read: async () => (i < chunks.length
            ? { done: false, value: enc.encode(chunks[i++]) }
            : { done: true, value: undefined }),
          cancel: async () => { onCancel?.(); },
        };
      },
    },
  };
}

async function collect(iter) {
  const out = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('readSSEStream', () => {
  it('yields parsed events across chunk boundaries that split lines', async () => {
    const res = fakeResponse(['data: {"a":', '1}\ndata: {"b":2}\n', 'data: {"c":3}']);
    expect(await collect(readSSEStream(res))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('passes done/error event objects through like any other event', async () => {
    const res = fakeResponse(['data: {"type":"step"}\ndata: {"type":"error","message":"boom"}\n']);
    const events = await collect(readSSEStream(res));
    expect(events).toEqual([{ type: 'step' }, { type: 'error', message: 'boom' }]);
  });

  it('stops yielding and cancels the reader when the signal aborts', async () => {
    const onCancel = vi.fn();
    const res = fakeResponse(['data: {"n":1}\n', 'data: {"n":2}\n', 'data: {"n":3}\n'], { onCancel });
    const ctrl = new AbortController();
    const seen = [];
    for await (const e of readSSEStream(res, { signal: ctrl.signal })) {
      seen.push(e);
      ctrl.abort(); // abort after the first event
    }
    expect(seen).toEqual([{ n: 1 }]);
    expect(onCancel).toHaveBeenCalled();
  });

  it('returns nothing for a response without a readable body', async () => {
    expect(await collect(readSSEStream({}))).toEqual([]);
    expect(await collect(readSSEStream(null))).toEqual([]);
  });
});
