// Tests for the WebSocket chat loop (server/lib/websocket.js, issue #44).
//
// runChatLoop drives: stream one model round -> if tool calls, execute them and
// loop -> else emit stats + save the session + done. It previously had zero
// coverage. We unit-test it through its `deps` injection seam with a fake `ws`,
// a scripted `streamChat` async generator, and stub collaborators — no real
// models, MCP, sandbox, or DB writes. Covers: streaming, thinking deltas, the
// tool loop + session shape, JSON-string tool args, save failure, abort, generic
// error, the MAX_TOOL_ROUNDS terminal, and the closed-socket guards.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runChatLoop, streamRound, MAX_TOOL_ROUNDS } = require('../lib/websocket');

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeWs(readyState = 1) {
  return {
    OPEN: 1,
    readyState,
    sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
    types() { return this.sent.map(m => m.type); },
    ofType(t) { return this.sent.filter(m => m.type === t); },
  };
}

// A streamChat stub that returns the next scripted round's events on each call.
function scriptStreamChat(rounds) {
  let i = 0;
  return () => {
    const events = rounds[i++] || [];
    return (async function* () { for (const ev of events) yield ev; })();
  };
}

function makeDeps(overrides = {}) {
  const calls = { saveSession: [], executeTool: [], setActive: 0, setIdle: 0 };
  const deps = {
    readAgent: () => ({
      name: 'Tester', tools: [], temperature: 0.5, max_tokens: 256,
      context_length: 4096, system_prompt: 'be nice', workspace: null,
    }),
    getToolDefinitions: () => [],
    executeTool: async (name, args) => { calls.executeTool.push({ name, args }); return { output: 'tool-ran' }; },
    saveSession: (agentId, sid, saveable) => { calls.saveSession.push({ agentId, sid, saveable }); },
    newSessionId: () => 'sess-new',
    readMemory: () => '',
    readShared: () => '',
    getOllamaUrl: () => 'http://localhost:11434',
    mcpManager: { clients: new Map(), isMcpTool: () => false, getServerName: () => null },
    activity: { setActive() { calls.setActive++; }, setIdle() { calls.setIdle++; } },
    streamChat: scriptStreamChat([[{ type: 'done', reason: 'stop' }]]),
    ...overrides,
  };
  return { deps, calls };
}

const USER = [{ role: 'user', content: 'hi' }];

// ── streamRound (unit) ───────────────────────────────────────────────────────

describe('streamRound', () => {
  it('accumulates text, streams chunks, and returns toolCalls/doneReason/stats', async () => {
    const ws = makeWs();
    const streamChat = scriptStreamChat([[
      { type: 'content', delta: 'Hel' },
      { type: 'content', delta: 'lo' },
      { type: 'tool_call', call: { id: 'c1', function: { name: 'shell', arguments: {} } } },
      { type: 'done', reason: 'length', stats: { input_tokens: 1, output_tokens: 2, tps: 9 } },
    ]]);
    const r = await streamRound(ws, [], 'm', [], null, {}, streamChat);
    assert.equal(r.text, 'Hello');
    assert.equal(r.doneReason, 'length');
    assert.deepEqual(r.stats, { input_tokens: 1, output_tokens: 2, tps: 9 });
    assert.equal(r.toolCalls.length, 1);
    assert.deepEqual(ws.ofType('chunk').map(c => c.content), ['Hel', 'lo']);
  });

  it('streams thinking deltas with kind:thinking and keeps them out of text', async () => {
    const ws = makeWs();
    const streamChat = scriptStreamChat([[
      { type: 'thinking', delta: 'pondering' },
      { type: 'content', delta: 'answer' },
      { type: 'done', reason: 'stop' },
    ]]);
    const r = await streamRound(ws, [], 'm', [], null, {}, streamChat);
    assert.equal(r.text, 'answer');
    const thinking = ws.ofType('chunk').filter(c => c.kind === 'thinking');
    assert.deepEqual(thinking.map(c => c.content), ['pondering']);
  });

  it('sends nothing when the socket is not open', async () => {
    const ws = makeWs(3); // CLOSED
    const streamChat = scriptStreamChat([[{ type: 'content', delta: 'x' }, { type: 'done', reason: 'stop' }]]);
    const r = await streamRound(ws, [], 'm', [], null, {}, streamChat);
    assert.equal(r.text, 'x');         // still accumulated
    assert.equal(ws.sent.length, 0);   // but nothing emitted
  });
});

// ── runChatLoop ────────────────────────────────────────────────────────────────

describe('runChatLoop — simple stream', () => {
  it('streams chunks, emits stats + done, saves the session, and clears the abort ctrl', async () => {
    const { deps, calls } = makeDeps({
      streamChat: scriptStreamChat([[
        { type: 'content', delta: 'Hel' },
        { type: 'content', delta: 'lo' },
        { type: 'done', reason: 'stop', stats: { input_tokens: 3, output_tokens: 2, tps: 5 } },
      ]]),
    });
    const ws = makeWs();
    await runChatLoop(ws, 'a1', USER, 'llama', null, deps);

    assert.deepEqual(ws.ofType('chunk').map(c => c.content), ['Hel', 'lo']);
    assert.deepEqual(ws.ofType('stats')[0], { type: 'stats', input_tokens: 3, output_tokens: 2, tps: 5 });
    const done = ws.ofType('done')[0];
    assert.equal(done.sessionId, 'sess-new');
    assert.equal(done.truncated, false);

    assert.equal(calls.saveSession.length, 1);
    const saveable = calls.saveSession[0].saveable;
    assert.deepEqual(saveable.map(m => [m.role, m.content]), [['user', 'hi'], ['assistant', 'Hello']]);
    assert.equal(calls.setActive, 1);
    assert.equal(calls.setIdle, 1);
    assert.equal(ws._abortCtrl, null);
  });

  it('marks done.truncated when the model stopped on length', async () => {
    const { deps } = makeDeps({
      streamChat: scriptStreamChat([[{ type: 'content', delta: 'cut' }, { type: 'done', reason: 'length' }]]),
    });
    const ws = makeWs();
    await runChatLoop(ws, 'a1', USER, 'llama', null, deps);
    assert.equal(ws.ofType('done')[0].truncated, true);
  });

  it('reuses a provided sessionId instead of minting one', async () => {
    const { deps, calls } = makeDeps({
      streamChat: scriptStreamChat([[{ type: 'content', delta: 'ok' }, { type: 'done', reason: 'stop' }]]),
    });
    const ws = makeWs();
    await runChatLoop(ws, 'a1', USER, 'llama', 'existing-sess', deps);
    assert.equal(ws.ofType('done')[0].sessionId, 'existing-sess');
    assert.equal(calls.saveSession[0].sid, 'existing-sess');
  });
});

describe('runChatLoop — tool loop', () => {
  it('runs the tool, emits done_partial/tool_call/tool_result, then a final done; session excludes tool intermediates', async () => {
    const { deps, calls } = makeDeps({
      streamChat: scriptStreamChat([
        [{ type: 'tool_call', call: { id: 'c1', function: { name: 'shell', arguments: { cmd: 'ls' } } } }, { type: 'done', reason: 'tool_calls' }],
        [{ type: 'content', delta: 'All done' }, { type: 'done', reason: 'stop' }],
      ]),
    });
    const ws = makeWs();
    await runChatLoop(ws, 'a1', USER, 'llama', null, deps);

    // event order: tool round, then the final answer streams a chunk before done
    assert.deepEqual(ws.types(), ['done_partial', 'tool_call', 'tool_result', 'chunk', 'done']);
    const tc = ws.ofType('tool_call')[0];
    assert.equal(tc.name, 'shell');
    assert.deepEqual(tc.args, { cmd: 'ls' });
    assert.deepEqual(ws.ofType('tool_result')[0].result, { output: 'tool-ran' });

    // executeTool got the parsed args + agentId
    assert.deepEqual(calls.executeTool[0], { name: 'shell', args: { cmd: 'ls' } });

    // saved session is the clean history + final answer (no tool role / no partials)
    const saveable = calls.saveSession[0].saveable;
    assert.deepEqual(saveable.map(m => [m.role, m.content]), [['user', 'hi'], ['assistant', 'All done']]);
  });

  it('parses tool-call arguments delivered as a JSON string', async () => {
    const { deps, calls } = makeDeps({
      streamChat: scriptStreamChat([
        [{ type: 'tool_call', call: { id: 'c1', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } } }, { type: 'done', reason: 'tool_calls' }],
        [{ type: 'content', delta: 'ok' }, { type: 'done', reason: 'stop' }],
      ]),
    });
    const ws = makeWs();
    await runChatLoop(ws, 'a1', USER, 'llama', null, deps);
    assert.deepEqual(calls.executeTool[0].args, { cmd: 'pwd' });
  });

  it('stops with an error after MAX_TOOL_ROUNDS without a final answer', async () => {
    // Every round asks for a tool again — never a tool-free finish.
    const { deps } = makeDeps({
      streamChat: () => (async function* () {
        yield { type: 'tool_call', call: { id: 'c', function: { name: 'noop', arguments: {} } } };
        yield { type: 'done', reason: 'tool_calls' };
      })(),
    });
    const ws = makeWs();
    await runChatLoop(ws, 'a1', USER, 'llama', null, deps);

    assert.equal(ws.ofType('done_partial').length, MAX_TOOL_ROUNDS);
    assert.equal(ws.ofType('done').length, 0); // never finished normally
    const err = ws.ofType('error')[0];
    assert.match(err.message, new RegExp(`Stopped after ${MAX_TOOL_ROUNDS} tool-call rounds`));
  });
});

describe('runChatLoop — error & abort branches', () => {
  it('emits session_save_error and a done WITHOUT sessionId when saving fails', async () => {
    const origError = console.error;
    console.error = () => {}; // silence the expected error log
    try {
      const { deps } = makeDeps({
        streamChat: scriptStreamChat([[{ type: 'content', delta: 'hi there' }, { type: 'done', reason: 'stop' }]]),
        saveSession: () => { throw new Error('disk full'); },
      });
      const ws = makeWs();
      await runChatLoop(ws, 'a1', USER, 'llama', null, deps);

      const saveErr = ws.ofType('session_save_error')[0];
      assert.equal(saveErr.detail, 'disk full');
      const done = ws.ofType('done')[0];
      assert.ok(done, 'done still sent after save failure');
      assert.equal('sessionId' in done, false); // omitted because save failed
    } finally {
      console.error = origError;
    }
  });

  it('sends {type:stopped} when the stream aborts, and still goes idle', async () => {
    const { deps, calls } = makeDeps({
      streamChat: () => (async function* () { const e = new Error('aborted'); e.name = 'AbortError'; throw e; })(),
    });
    const ws = makeWs();
    await runChatLoop(ws, 'a1', USER, 'llama', null, deps);
    assert.deepEqual(ws.types(), ['stopped']);
    assert.equal(calls.setIdle, 1);
    assert.equal(ws._abortCtrl, null);
  });

  it('sends {type:error} with the message on a generic failure', async () => {
    const { deps, calls } = makeDeps({
      streamChat: () => (async function* () { throw new Error('model exploded'); })(),
    });
    const ws = makeWs();
    await runChatLoop(ws, 'a1', USER, 'llama', null, deps);
    const err = ws.ofType('error')[0];
    assert.equal(err.message, 'model exploded');
    assert.equal(calls.setIdle, 1);
  });
});
