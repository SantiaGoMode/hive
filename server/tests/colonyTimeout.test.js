// colonyTimeoutMs — the configurable inactivity window for a colony run.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/config');
const { colonyTimeoutMs, COLONY_MAX_DURATION_MS } = require('../lib/colonyRunner');

const orig = config.getSetting;
function withSetting(value, fn) {
  config.getSetting = (key, fb = '') => (key === 'colony_timeout_minutes' ? value : orig(key, fb));
  try { return fn(); } finally { config.getSetting = orig; }
}

describe('colonyTimeoutMs', () => {
  after(() => { config.getSetting = orig; });

  it('defaults to the 30-minute window when unset', () => {
    assert.equal(withSetting('', () => colonyTimeoutMs()), COLONY_MAX_DURATION_MS);
  });

  it('honors a configured value in minutes', () => {
    assert.equal(withSetting('90', () => colonyTimeoutMs()), 90 * 60 * 1000);
  });

  it('clamps absurd values into a sane range (5 min … 12 h)', () => {
    assert.equal(withSetting('1', () => colonyTimeoutMs()), 5 * 60 * 1000);     // floor
    assert.equal(withSetting('99999', () => colonyTimeoutMs()), 720 * 60 * 1000); // ceiling
  });

  it('falls back to the default on a non-numeric value', () => {
    assert.equal(withSetting('soon', () => colonyTimeoutMs()), COLONY_MAX_DURATION_MS);
  });
});
