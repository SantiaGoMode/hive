// Tests for the structured logger + ring buffer (issue #31).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { logger, noteSwallowed, getRecentLogs, newRequestId, _resetLogs, RING_MAX } = require('../lib/logger');

let savedLevel;
before(() => { savedLevel = process.env.LOG_LEVEL; process.env.LOG_LEVEL = 'silent'; }); // quiet console; buffer still records
after(() => { if (savedLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = savedLevel; });
beforeEach(() => _resetLogs());

describe('ring buffer', () => {
  it('records warn and error but not info/debug', () => {
    logger.debug('c', 'd');
    logger.info('c', 'i');
    logger.warn('c', 'w');
    logger.error('c', 'e');
    const events = getRecentLogs().map(l => l.event);
    assert.deepEqual(events, ['w', 'e']);
  });

  it('caps the buffer at RING_MAX (drops oldest)', () => {
    for (let i = 0; i < RING_MAX + 25; i++) logger.warn('c', `w${i}`);
    const logs = getRecentLogs();
    assert.equal(logs.length, RING_MAX);
    assert.equal(logs[logs.length - 1].event, `w${RING_MAX + 24}`); // newest kept
    assert.equal(logs[0].event, `w25`);                              // oldest 25 dropped
  });

  it('getRecentLogs(limit) returns the newest N', () => {
    for (let i = 0; i < 5; i++) logger.error('c', `e${i}`);
    assert.deepEqual(getRecentLogs(2).map(l => l.event), ['e3', 'e4']);
  });

  it('entries carry ts, level, component, event', () => {
    logger.error('scheduler', 'tick_failed', { id: 'x' });
    const e = getRecentLogs()[0];
    assert.equal(e.level, 'error');
    assert.equal(e.component, 'scheduler');
    assert.equal(e.event, 'tick_failed');
    assert.equal(typeof e.ts, 'number');
    assert.deepEqual(e.meta, { id: 'x' });
  });
});

describe('redaction & safety', () => {
  it('redacts secrets from metadata', () => {
    logger.error('c', 'e', {
      api_key: 'sk-abcdef123456',
      apiKey: 'plain-structured-secret',
      nested: { refresh_token: 'nested-secret', password: 'hunter22222' },
      auth: 'Bearer abcdef123456xyz',
    });
    const blob = JSON.stringify(getRecentLogs()[0].meta);
    assert.ok(!blob.includes('sk-abcdef123456'), 'sk- key redacted');
    assert.ok(!blob.includes('plain-structured-secret'), 'camel-case api key redacted');
    assert.ok(!blob.includes('nested-secret'), 'nested token redacted');
    assert.ok(!blob.includes('hunter22222'), 'password redacted');
    assert.ok(!blob.includes('abcdef123456xyz'), 'bearer token redacted');
  });

  it('never throws on circular metadata', () => {
    const o = { a: 1 };
    o.self = o;
    assert.doesNotThrow(() => logger.error('c', 'e', o));
    assert.equal(getRecentLogs()[0].meta.self, '[circular]');
  });

  it('never throws when console.error itself throws', () => {
    const orig = console.error;
    process.env.LOG_LEVEL = 'error'; // force console path
    console.error = () => { throw new Error('console boom'); };
    try {
      assert.doesNotThrow(() => logger.error('c', 'e'));
    } finally {
      console.error = orig;
      process.env.LOG_LEVEL = 'silent';
    }
    assert.equal(getRecentLogs()[0].event, 'e'); // still buffered
  });
});

describe('noteSwallowed', () => {
  it('records a swallowed error into the buffer as a warn', () => {
    noteSwallowed('colonyRunner:cleanup', 'container missing', { agentId: 'a1' });
    const e = getRecentLogs()[0];
    assert.equal(e.level, 'warn');
    assert.equal(e.component, 'swallowed');
    assert.equal(e.event, 'colonyRunner:cleanup');
    assert.equal(e.meta.message, 'container missing');
    assert.equal(e.meta.agentId, 'a1');
  });
});

describe('newRequestId', () => {
  it('returns a short, unique-ish id', () => {
    const a = newRequestId();
    const b = newRequestId();
    assert.equal(a.length, 8);
    assert.notEqual(a, b);
  });
});
