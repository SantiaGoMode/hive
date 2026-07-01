// Tests for the shared system-prompt scaffold (server/lib/systemPrompt.js, #30).
//
// buildSystemPrompt is the single source of truth for the identity + user-prompt +
// memory block that both the WebSocket chat loop (mode 'chat') and the agent
// tool-loop (mode 'agent') prepend to every system prompt. These tests pin the
// exact text each mode produces so the two call sites can't silently drift — they
// assert the identity anchor wording, the mode-specific extras (chat formatting/
// hello line vs the lean agent anchor), and the memory-present/absent branches with
// their differing memory headers.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt, DEFAULT_USER_PROMPT } = require('../lib/systemPrompt');

describe('buildSystemPrompt — chat mode (WebSocket)', () => {
  it('emits the full identity anchor with hello + FORMATTING and no memory when memory is empty', () => {
    const out = buildSystemPrompt(
      { name: 'Nova', system_prompt: 'Do the thing.' },
      { mode: 'chat', agentId: 'a1', memory: '' },
    );
    assert.equal(
      out,
      'You are Nova, an AI assistant running in Hive.\n' +
      'Your name is Nova. You are a Hive assistant.\n' +
      'If someone says "hello" or asks who you are, introduce yourself as a Hive assistant: ' +
      '"Hi! I\'m Nova, a Hive assistant. How can I help you?"\n' +
      'Do not identify yourself as any underlying model or company.\n\n' +
      'FORMATTING: Always use markdown to structure your responses. ' +
      'Use bullet points or numbered lists for multiple items, bold for key terms, ' +
      'headers for distinct sections, and code blocks for any code or commands. ' +
      'Never write long unbroken paragraphs — break ideas into readable chunks.\n\n' +
      'Do the thing.',
    );
    assert.ok(!out.includes('[Your memory from previous sessions]'));
  });

  it('appends the chat memory block with its "[Your memory from previous sessions]" header when memory is present', () => {
    const out = buildSystemPrompt(
      { name: 'Nova', system_prompt: 'Do the thing.' },
      { mode: 'chat', agentId: 'a1', memory: 'user likes tea' },
    );
    assert.ok(out.endsWith(
      'Do the thing.\n\n---\n[Your memory from previous sessions]\nuser likes tea\n---',
    ), out);
  });

  it('falls back to the default user prompt when system_prompt is missing/whitespace', () => {
    const out = buildSystemPrompt(
      { name: 'Nova', system_prompt: '   ' },
      { mode: 'chat', agentId: 'a1', memory: '' },
    );
    assert.ok(out.endsWith('\n\n' + DEFAULT_USER_PROMPT), out);
    assert.equal(DEFAULT_USER_PROMPT, 'Be helpful, direct, and concise.');
  });

  it('uses agentId for the name when agent.name is absent', () => {
    const out = buildSystemPrompt({}, { mode: 'chat', agentId: 'socket-42', memory: '' });
    assert.ok(out.startsWith('You are socket-42, an AI assistant running in Hive.\n'));
  });
});

describe('buildSystemPrompt — agent mode (colony/pipeline)', () => {
  it('emits the lean identity anchor (no hello/FORMATTING) and no memory when empty', () => {
    const out = buildSystemPrompt(
      { name: 'Worker', id: 'w1', system_prompt: 'Ship it.' },
      { mode: 'agent', agentId: 'w1', memory: '' },
    );
    assert.equal(
      out,
      'You are Worker, an AI assistant running in Hive.\n' +
      'Your name is Worker. You are a Hive assistant.\n' +
      'Do not identify yourself as any underlying model or company.\n\n' +
      'Ship it.',
    );
    assert.ok(!out.includes('If someone says "hello"'));
    assert.ok(!out.includes('FORMATTING:'));
  });

  it('appends the agent memory block with its "[Memory from previous sessions]" header when memory is present', () => {
    const out = buildSystemPrompt(
      { name: 'Worker', id: 'w1', system_prompt: 'Ship it.' },
      { mode: 'agent', agentId: 'w1', memory: 'prefers concise output' },
    );
    assert.ok(out.endsWith(
      'Ship it.\n\n---\n[Memory from previous sessions]\nprefers concise output\n---',
    ), out);
    // The agent header must NOT be the chat "[Your memory...]" variant.
    assert.ok(!out.includes('[Your memory from previous sessions]'));
  });

  it('falls back to the default user prompt and to agent.id for the name', () => {
    const out = buildSystemPrompt({ id: 'w9' }, { mode: 'agent', agentId: 'w9', memory: '' });
    assert.ok(out.startsWith('You are w9, an AI assistant running in Hive.\n'));
    assert.ok(out.endsWith('\n\n' + DEFAULT_USER_PROMPT), out);
  });
});
