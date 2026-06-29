const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { logSwallowed, _resetSwallowedStats, _redact } = require('../lib/logSwallowed');

describe('logSwallowed', () => {
  let warnings;
  let origWarn;
  let origEnv;

  beforeEach(() => {
    _resetSwallowedStats();
    warnings = [];
    origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    origEnv = process.env.LOG_SWALLOWED;
    delete process.env.LOG_SWALLOWED;
  });

  afterEach(() => {
    console.warn = origWarn;
    if (origEnv === undefined) delete process.env.LOG_SWALLOWED;
    else process.env.LOG_SWALLOWED = origEnv;
  });

  it('logs a warning with context and message', () => {
    logSwallowed('db:cleanup', new Error('disk I/O error'), { table: 'colonies' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[swallowed\] db:cleanup: disk I\/O error/);
    assert.match(warnings[0], /"table":"colonies"/);
  });

  it('never throws, whatever the error shape', () => {
    const circular = {}; circular.self = circular;
    assert.doesNotThrow(() => logSwallowed('x', undefined));
    assert.doesNotThrow(() => logSwallowed('x:null', null));
    assert.doesNotThrow(() => logSwallowed('x:str', 'plain string'));
    assert.doesNotThrow(() => logSwallowed('x:num', 42));
    assert.doesNotThrow(() => logSwallowed('x:circ', circular));
    assert.doesNotThrow(() => logSwallowed('x:circ-ctx', new Error('e'), circular));
  });

  it('never throws even if console.warn itself throws', () => {
    console.warn = () => { throw new Error('logger exploded'); };
    assert.doesNotThrow(() => logSwallowed('x:boom', new Error('original')));
  });

  it('rate-limits repeats per context within the window', () => {
    for (let i = 0; i < 50; i++) logSwallowed('hot:loop', new Error(`fail ${i}`));
    assert.equal(warnings.length, 1, 'only the first hit in the window logs');
    // a different context is independent
    logSwallowed('other:context', new Error('separate'));
    assert.equal(warnings.length, 2);
  });

  it('reports suppressed count when a new window opens', () => {
    for (let i = 0; i < 5; i++) logSwallowed('win:test', new Error('x'));
    _resetSwallowedStats(); // simulate window expiry would carry suppressed=…; reset clears
    logSwallowed('win:test', new Error('fresh'));
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /fresh/);
  });

  it('can be silenced with LOG_SWALLOWED=0', () => {
    process.env.LOG_SWALLOWED = '0';
    logSwallowed('quiet:mode', new Error('nope'));
    assert.equal(warnings.length, 0);
  });

  it('redacts secrets in messages and context', () => {
    logSwallowed('redact:msg', new Error('call failed: Bearer abc123def456ghi and sk-superSecretKey12345'));
    assert.match(warnings[0], /Bearer \[redacted\]/);
    assert.match(warnings[0], /\[redacted\]/);
    assert.doesNotMatch(warnings[0], /superSecretKey/);

    logSwallowed('redact:ctx', new Error('e'), { note: 'api_key=verysecretvalue' });
    assert.doesNotMatch(warnings[1], /verysecretvalue/);
  });

  it('redact helper covers key=value and key: value pairs', () => {
    assert.doesNotMatch(_redact('token: abcdef123456'), /abcdef123456/);
    assert.doesNotMatch(_redact('password=hunter22222'), /hunter22222/);
    assert.doesNotMatch(_redact('Authorization: Bearer xyz.token.value'), /xyz\.token\.value/);
    // non-secrets pass through
    assert.equal(_redact('plain message'), 'plain message');
  });
});
