// Tests for the Hive-owned Ollama streaming path (issue #37).
//
// ai-sdk-ollama never forwards the abort signal to its HTTP client, so an
// aborted run used to leave the Ollama generation running server-side (the
// staff-chat 180s hang). streamChat() now drives provider==='ollama' through a
// direct /api/chat fetch with the real AbortSignal. These tests cover:
//   • the pure message/tool/stats adapters (no network)
//   • normalized event emission from an NDJSON stream (content/thinking/tool/done)
//   • HTTP error surfacing
//   • REAL cancellation — aborting closes the upstream socket, not just the reader

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const db = require('../db');
const { streamChat } = require('../lib/providers');
const { toOllamaMessages, toOllamaTools, ollamaStats } = require('../lib/providers/adapters');

// ── Pure adapters ──────────────────────────────────────────────────────────────

describe('toOllamaMessages', () => {
  it('passes plain text user/assistant/system through', () => {
    assert.deepEqual(toOllamaMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]), [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
  });

  it('extracts data-URI images into a base64 images[] array', () => {
    assert.deepEqual(toOllamaMessages([
      { role: 'user', content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ] },
    ]), [
      { role: 'user', content: 'what is this', images: ['QUJD'] },
    ]);
  });

  it('maps assistant tool calls to Ollama function shape with normalized args', () => {
    const out = toOllamaMessages([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'shell', arguments: "{'cmd': 'ls'}" } }] },
    ]);
    assert.deepEqual(out[0].tool_calls, [{ function: { name: 'shell', arguments: { cmd: 'ls' } } }]);
  });

  it('maps a tool result to role:tool with tool_name', () => {
    const out = toOllamaMessages([
      { role: 'tool', content: '{"ok":true}', name: 'shell', tool_call_id: 'call_1' },
    ]);
    assert.deepEqual(out[0], { role: 'tool', content: '{"ok":true}', tool_name: 'shell' });
  });
});

describe('toOllamaTools', () => {
  it('wraps function defs and skips nameless entries', () => {
    const out = toOllamaTools([
      { type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } },
      { function: {} },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } });
  });

  it('returns undefined for empty / non-array input', () => {
    assert.equal(toOllamaTools([]), undefined);
    assert.equal(toOllamaTools(null), undefined);
  });
});

describe('ollamaStats', () => {
  it('maps token counts and computes tps from eval_duration (ns)', () => {
    assert.deepEqual(ollamaStats({ prompt_eval_count: 10, eval_count: 20, eval_duration: 1e9 }),
      { input_tokens: 10, output_tokens: 20, tps: 20 }); // 20 tokens / 1s
  });
  it('leaves tps null when duration is missing, and maps null overall', () => {
    assert.deepEqual(ollamaStats({ prompt_eval_count: 5, eval_count: 7 }),
      { input_tokens: 5, output_tokens: 7, tps: null });
    assert.equal(ollamaStats(null), null);
  });
});

// ── Fake Ollama /api/chat server ───────────────────────────────────────────────

function ndjson(lines) {
  return lines.map(o => JSON.stringify(o) + '\n').join('');
}

describe('streamChat ollama path', () => {
  let server;
  let url;
  let handler;            // (req, res) => void, set per test
  const sockets = new Set();

  before(async () => {
    server = http.createServer((req, res) => { handler(req, res); });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    url = `http://127.0.0.1:${server.address().port}`;
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('ollama_url', ?) "
      + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(url);
  });
  after(() => {
    for (const s of sockets) s.destroy();
    server.close();
    db.prepare("DELETE FROM app_settings WHERE key='ollama_url'").run();
  });

  async function collect(opts = {}) {
    const events = [];
    for await (const ev of streamChat('ollama/fake-model', {
      messages: [{ role: 'user', content: 'hi' }],
      ...opts,
    })) events.push(ev);
    return events;
  }

  it('normalizes a full NDJSON stream into content/thinking/tool_call/done', async () => {
    handler = (req, res) => {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.end(ndjson([
        { message: { role: 'assistant', thinking: 'hmm' }, done: false },
        { message: { role: 'assistant', content: 'Hello' }, done: false },
        { message: { role: 'assistant', content: ' world' }, done: false },
        { message: { role: 'assistant', tool_calls: [{ function: { name: 'shell', arguments: { cmd: 'ls' } } }] }, done: false },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 20, eval_duration: 1e9 },
      ]));
    };
    const events = await collect();
    const content = events.filter(e => e.type === 'content').map(e => e.delta).join('');
    const thinking = events.filter(e => e.type === 'thinking').map(e => e.delta).join('');
    const calls = events.filter(e => e.type === 'tool_call');
    const done = events.find(e => e.type === 'done');

    assert.equal(content, 'Hello world');
    assert.equal(thinking, 'hmm');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].call.function.name, 'shell');
    assert.deepEqual(calls[0].call.function.arguments, { cmd: 'ls' });
    assert.ok(calls[0].call.id, 'tool call gets a synthesized id');
    assert.equal(done.reason, 'stop');
    assert.deepEqual(done.stats, { input_tokens: 10, output_tokens: 20, tps: 20 });
  });

  it('surfaces an HTTP error from Ollama', async () => {
    handler = (req, res) => { res.statusCode = 500; res.end('model runner crashed'); };
    await assert.rejects(() => collect(), /Ollama request failed \(500\).*model runner crashed/s);
  });

  it('aborting actually closes the upstream request socket (real cancellation)', async () => {
    let sawServerClose;
    const serverClosed = new Promise((resolve) => { sawServerClose = resolve; });
    handler = (req, res) => {
      // The server side observes the socket closing only if the client truly
      // aborts the request — not if Hive merely stops reading.
      req.on('close', () => sawServerClose());
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false }) + '\n');
      // ...then hang forever (a slow/stuck model).
    };

    const ctrl = new AbortController();
    const events = [];
    const consume = (async () => {
      for await (const ev of streamChat('ollama/fake-model', {
        messages: [{ role: 'user', content: 'hi' }],
        signal: ctrl.signal,
      })) {
        events.push(ev);
        if (ev.type === 'content') ctrl.abort(); // abort as soon as the first token lands
      }
    })();

    await assert.rejects(() => consume, (e) => e.name === 'AbortError');
    await serverClosed; // resolves only because the abort closed the upstream socket
    assert.equal(events[0].delta, 'partial'); // we did stream the first token first
  });
});
