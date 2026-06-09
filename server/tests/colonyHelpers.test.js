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

  it('truncates string values over 1500 chars and appends ellipsis', () => {
    const longStr = 'x'.repeat(1600);
    const result = truncateArgs({ content: longStr });
    assert.equal(result.content.length, 1501); // 1500 + '…'
    assert.ok(result.content.endsWith('…'));
    assert.equal(result.content.slice(0, 1500), 'x'.repeat(1500));
  });

  it('does not truncate strings exactly 1500 chars', () => {
    const str1500 = 'a'.repeat(1500);
    const result = truncateArgs({ content: str1500 });
    assert.equal(result.content, str1500);
    assert.equal(result.content.length, 1500);
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

  it('truncates a long plain string to 8000 chars + ellipsis', () => {
    const longStr = 'z'.repeat(9000);
    const result = truncateResult(longStr);
    assert.equal(typeof result, 'string');
    assert.equal(result.length, 8001); // 8000 + '…'
    assert.ok(result.endsWith('…'));
  });

  it('truncates long string fields inside an object when total JSON > 8000 bytes', () => {
    const longVal = 'y'.repeat(1200);
    // Make a big enough object that JSON.stringify > 8000
    const obj = {};
    for (let i = 0; i < 10; i++) obj[`field${i}`] = longVal;
    const result = truncateResult(obj);
    for (const key of Object.keys(result)) {
      if (typeof result[key] === 'string') {
        assert.ok(result[key].length <= 1001); // 1000 + '…'
      }
    }
  });

  it('keeps up to 6000 chars of a worker `response` field', () => {
    const obj = { response: 'r'.repeat(7000) };
    for (let i = 0; i < 5; i++) obj[`field${i}`] = 'y'.repeat(1200);
    const result = truncateResult(obj);
    assert.equal(result.response.length, 6001); // 6000 + '…'
  });

  it('leaves short fields intact when object is large overall', () => {
    const obj = {};
    for (let i = 0; i < 10; i++) obj[`field${i}`] = 'y'.repeat(1200);
    obj.shortField = 'ok';
    const result = truncateResult(obj);
    assert.equal(result.shortField, 'ok');
  });

  it('does not truncate object under 8000 bytes even with long-ish fields', () => {
    const obj = { output: 'x'.repeat(100), exitCode: 0 };
    const result = truncateResult(obj);
    assert.equal(result.output, obj.output);
  });
});
