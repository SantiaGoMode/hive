const { describe, it, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Guard: when the gateway spend-logs fetch fails, the Settings panel message
// (persistence.message) must tell the user what to DO, not just what broke —
// a 401 means "enter your LiteLLM master key", not "swallowed fetchSpendLogs".
describe('gateway spend summary error messages', () => {
  const orig = { url: process.env.LLM_GATEWAY_URL, key: process.env.LLM_GATEWAY_KEY };
  const savedFetch = global.fetch;
  let gatewaySpend;

  before(() => {
    process.env.LLM_GATEWAY_URL = 'http://127.0.0.1:4000/v1';
    delete process.env.LLM_GATEWAY_KEY;
    gatewaySpend = require('../lib/gatewaySpend');
  });
  after(() => {
    if (orig.url === undefined) delete process.env.LLM_GATEWAY_URL; else process.env.LLM_GATEWAY_URL = orig.url;
    if (orig.key === undefined) delete process.env.LLM_GATEWAY_KEY; else process.env.LLM_GATEWAY_KEY = orig.key;
    global.fetch = savedFetch;
  });
  beforeEach(() => { gatewaySpend._resetForTests(); });

  it('tells the user to enter the master key on HTTP 401', async () => {
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const summary = await gatewaySpend.getGatewaySpendSummary({ force: true });
    assert.equal(summary.reachable, false);
    assert.equal(summary.persistence.spend_logs_reachable, false);
    assert.match(summary.persistence.message, /LiteLLM master key/);
    assert.match(summary.persistence.message, /LLM_GATEWAY_KEY/);
  });

  it('points at the gateway README for other HTTP errors', async () => {
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const summary = await gatewaySpend.getGatewaySpendSummary({ force: true });
    assert.match(summary.persistence.message, /HTTP 500/);
    assert.match(summary.persistence.message, /gateway\/README\.md/);
  });

  it('suggests checking the container when the gateway is unreachable', async () => {
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    const summary = await gatewaySpend.getGatewaySpendSummary({ force: true });
    assert.match(summary.persistence.message, /LiteLLM container is running/);
  });

  it('suggests checking the container on timeout', async () => {
    global.fetch = async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    };
    const summary = await gatewaySpend.getGatewaySpendSummary({ force: true });
    assert.match(summary.persistence.message, /did not respond in time/);
  });
});
