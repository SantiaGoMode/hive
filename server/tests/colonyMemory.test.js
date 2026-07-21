const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { unsafeStoppedRepoFact } = require('../lib/colony/memory');

describe('colony memory sanitizer', () => {
  it('filters stopped-run repo-shape claims that are not framed as unverified', () => {
    assert.equal(
      unsafeStoppedRepoFact('Repository initialization failed; package.json and README.md are missing from the root directory.', 'stopped'),
      true,
    );
    assert.equal(
      unsafeStoppedRepoFact('Stopped run had file-access blockers; verify the intended PR branch before treating package.json errors as repo facts.', 'stopped'),
      false,
    );
    assert.equal(
      unsafeStoppedRepoFact('package.json is missing from the root directory.', 'done'),
      false,
    );
  });
});
