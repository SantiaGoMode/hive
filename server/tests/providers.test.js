const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Pure adapters only — no `ai` SDK or DB import, so this runs without the cloud
// packages installed. (Live streaming is verified manually on the host.)
const {
  parseModel, normalizeArgs, splitSystem, toModelMessages, mapUsage,
} = require('../lib/providers/adapters');

describe('parseModel', () => {
  it('routes known prefixes', () => {
    assert.deepEqual(parseModel('anthropic/claude-sonnet-4-6'), { provider: 'anthropic', modelId: 'claude-sonnet-4-6' });
    assert.deepEqual(parseModel('openai/gpt-5'), { provider: 'openai', modelId: 'gpt-5' });
    assert.deepEqual(parseModel('gemini/gemini-2.5-pro'), { provider: 'gemini', modelId: 'gemini-2.5-pro' });
  });
  it('defaults bare and ollama-prefixed names to ollama', () => {
    assert.deepEqual(parseModel('llama3.1:8b'), { provider: 'ollama', modelId: 'llama3.1:8b' });
    assert.deepEqual(parseModel('ollama/qwen3'), { provider: 'ollama', modelId: 'qwen3' });
  });
  it('treats unknown prefixes as ollama (e.g. hf-style names)', () => {
    assert.deepEqual(parseModel('library/foo:tag'), { provider: 'ollama', modelId: 'library/foo:tag' });
  });
  it('routes gateway capability aliases to the gateway provider', () => {
    assert.deepEqual(parseModel('gateway/hive-smart'), { provider: 'gateway', modelId: 'hive-smart' });
    assert.deepEqual(parseModel('gateway/hive-coding'), { provider: 'gateway', modelId: 'hive-coding' });
  });
});

describe('normalizeArgs', () => {
  it('passes objects through and parses json/python-ish strings', () => {
    assert.deepEqual(normalizeArgs({ a: 1 }), { a: 1 });
    assert.deepEqual(normalizeArgs('{"a":1}'), { a: 1 });
    assert.deepEqual(normalizeArgs("{'a': 1}"), { a: 1 });
    assert.deepEqual(normalizeArgs(null), {});
  });
});

describe('splitSystem', () => {
  it('extracts the leading system message', () => {
    const { system, rest } = splitSystem([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(system, 'sys');
    assert.equal(rest.length, 1);
    assert.equal(rest[0].role, 'user');
  });
});

describe('toModelMessages', () => {
  it('maps a plain user/assistant exchange', () => {
    const out = toModelMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('maps assistant tool calls to tool-call parts and correlates tool results by id', () => {
    const out = toModelMessages([
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'shell', arguments: { cmd: 'ls' } } }] },
      { role: 'tool', content: JSON.stringify({ ok: true }), tool_call_id: 'call_1', name: 'shell' },
    ]);
    // assistant message has a tool-call part
    const asst = out[1];
    assert.equal(asst.role, 'assistant');
    const callPart = asst.content.find(p => p.type === 'tool-call');
    assert.equal(callPart.toolCallId, 'call_1');
    assert.equal(callPart.toolName, 'shell');
    assert.deepEqual(callPart.input, { cmd: 'ls' });
    // tool message has a matching tool-result part with json output
    const toolMsg = out[2];
    assert.equal(toolMsg.role, 'tool');
    const resPart = toolMsg.content[0];
    assert.equal(resPart.type, 'tool-result');
    assert.equal(resPart.toolCallId, 'call_1');
    assert.equal(resPart.toolName, 'shell');
    assert.deepEqual(resPart.output, { type: 'json', value: { ok: true } });
  });

  it('correlates tool results by name+order when ids are absent (legacy)', () => {
    const out = toModelMessages([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: {} } }] },
      { role: 'tool', content: 'plain text result' },
    ]);
    const callId = out[0].content.find(p => p.type === 'tool-call').toolCallId;
    const resPart = out[1].content[0];
    assert.equal(resPart.toolCallId, callId); // same generated id
    assert.deepEqual(resPart.output, { type: 'text', value: 'plain text result' });
  });

  it('maps multimodal user content (text + image_url)', () => {
    const out = toModelMessages([
      { role: 'user', content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ]);
    assert.deepEqual(out[0].content, [
      { type: 'text', text: 'what is this' },
      { type: 'image', image: 'data:image/png;base64,AAAA' },
    ]);
  });
});

describe('mapUsage', () => {
  it('maps SDK usage to hive stats', () => {
    assert.deepEqual(mapUsage({ inputTokens: 10, outputTokens: 20 }), { input_tokens: 10, output_tokens: 20, tps: null });
    assert.equal(mapUsage(null), null);
  });
});
