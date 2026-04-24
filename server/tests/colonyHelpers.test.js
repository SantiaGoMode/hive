const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { truncateArgs, truncateResult } = require('../lib/colonyRunner');

describe('truncateArgs', () => {
  it('passes through non-object values unchanged', () => {
    assert.equal(truncateArgs(null), null);
    assert.equal(truncateArgs(undefined), undefined);
    assert.equal(truncateArgs('string'), 'string');
    assert.equal(truncateArgs(42), 42);
  });

  it('passes through short string values unchanged', () => {
    const args = { command: 'ls -la', path: '/workspace' };
    const result = truncateArgs(args);
    assert.equal(result.command, 'ls -la');
    assert.equal(result.path, '/workspace');
  });

  it('truncates string values over 500 chars and appends ellipsis', () => {
    const longStr = 'x'.repeat(600);
    const result = truncateArgs({ content: longStr });
    assert.equal(result.content.length, 501); // 500 + '…'
    assert.ok(result.content.endsWith('…'));
    assert.equal(result.content.slice(0, 500), 'x'.repeat(500));
  });

  it('does not truncate strings exactly 500 chars', () => {
    const str500 = 'a'.repeat(500);
    const result = truncateArgs({ content: str500 });
    assert.equal(result.content, str500);
    assert.equal(result.content.length, 500);
  });

  it('leaves non-string values in objects untouched', () => {
    const args = { count: 42, flag: true, data: [1, 2, 3] };
    const result = truncateArgs(args);
    assert.equal(result.count, 42);
    assert.equal(result.flag, true);
    assert.deepEqual(result.data, [1, 2, 3]);
  });

  it('does not mutate the input object', () => {
    const longStr = 'x'.repeat(600);
    const args = { content: longStr };
    truncateArgs(args);
    assert.equal(args.content.length, 600); // original unchanged
  });
});

describe('truncateResult', () => {
  it('returns null/undefined as-is', () => {
    assert.equal(truncateResult(null), null);
    assert.equal(truncateResult(undefined), undefined);
  });

  it('returns small objects untouched', () => {
    const obj = { success: true, output: 'hello' };
    const result = truncateResult(obj);
    assert.deepEqual(result, obj);
  });

  it('returns small strings untouched', () => {
    assert.equal(truncateResult('hello world'), 'hello world');
  });

  it('truncates a long plain string to 2000 chars + ellipsis', () => {
    const longStr = 'z'.repeat(3000);
    const result = truncateResult(longStr);
    assert.equal(typeof result, 'string');
    assert.equal(result.length, 2001); // 2000 + '…'
    assert.ok(result.endsWith('…'));
  });

  it('truncates long string fields inside an object when total JSON > 2000 bytes', () => {
    const longVal = 'y'.repeat(400);
    // Make a big enough object that JSON.stringify > 2000
    const obj = {};
    for (let i = 0; i < 10; i++) obj[`field${i}`] = longVal;
    // Each field is 400 chars; 10 fields => JSON is well over 2000 chars
    const result = truncateResult(obj);
    for (const key of Object.keys(result)) {
      if (typeof result[key] === 'string') {
        assert.ok(result[key].length <= 301); // 300 + '…'
      }
    }
  });

  it('leaves short fields intact when object is large overall', () => {
    const obj = {};
    for (let i = 0; i < 10; i++) obj[`field${i}`] = 'y'.repeat(400);
    obj.shortField = 'ok';
    const result = truncateResult(obj);
    assert.equal(result.shortField, 'ok');
  });

  it('does not truncate object under 2000 bytes even with long-ish fields', () => {
    const obj = { output: 'x'.repeat(100), exitCode: 0 };
    const result = truncateResult(obj);
    assert.equal(result.output, obj.output);
  });
});
