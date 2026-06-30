// Unit tests for pipelineRunner pure helpers (issue #46). The full
// runPipelineById execution path drives real agent runs and is covered by the
// pipeline cancellation/route tests; here we cover the deterministic helpers.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { groupSteps, renderStepPrompt, abortError, isAbortError } = require('../lib/pipelineRunner');

describe('groupSteps', () => {
  it('keeps non-parallel steps as singleton groups', () => {
    const groups = groupSteps([{}, {}, {}]);
    assert.deepEqual(groups, [
      { parallel: false, indices: [0] },
      { parallel: false, indices: [1] },
      { parallel: false, indices: [2] },
    ]);
  });
  it('coalesces consecutive parallel steps into one group', () => {
    const groups = groupSteps([{}, { parallel: true }, { parallel: true }, {}]);
    assert.deepEqual(groups, [
      { parallel: false, indices: [0] },
      { parallel: true, indices: [1, 2] },
      { parallel: false, indices: [3] },
    ]);
  });
  it('handles an empty pipeline', () => {
    assert.deepEqual(groupSteps([]), []);
  });
});

describe('renderStepPrompt', () => {
  it('substitutes {input} and {prev} (all occurrences)', () => {
    assert.equal(renderStepPrompt({ prompt: '{input} then {prev} then {input}' }, 'IN', 'PREV'), 'IN then PREV then IN');
  });
  it('defaults to {prev} when no prompt is set', () => {
    assert.equal(renderStepPrompt({}, 'IN', 'PREV'), 'PREV');
  });
});

describe('abort helpers', () => {
  it('abortError is a named AbortError', () => {
    const e = abortError();
    assert.equal(e.name, 'AbortError');
    assert.match(e.message, /stopped/i);
  });
  it('isAbortError recognizes aborted signals, AbortError, and stop messages', () => {
    assert.equal(isAbortError(abortError()), true);
    assert.equal(isAbortError(null, { aborted: true }), true);
    assert.equal(isAbortError(new Error('Colony run was stopped')), true);
    assert.equal(isAbortError(new Error('something else')), false);
    assert.equal(isAbortError(new Error('something else'), { aborted: false }), false);
  });
});
