const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Guard: when an LLM gateway is configured, listAllModels() must expose a
// `gateway` group of capability aliases (so the client pickers can render them).
describe('gateway model listing', () => {
  const orig = process.env.LLM_GATEWAY_URL;
  before(() => { process.env.LLM_GATEWAY_URL = 'http://127.0.0.1:4000/v1'; });
  after(() => {
    if (orig === undefined) delete process.env.LLM_GATEWAY_URL;
    else process.env.LLM_GATEWAY_URL = orig;
  });

  it('includes a gateway group of capability aliases when configured', async () => {
    const { listAllModels } = require('../lib/providers/listModels');
    const grouped = await listAllModels();
    assert.ok(Array.isArray(grouped.gateway), 'gateway group is present');
    const ids = grouped.gateway.map(e => e.id);
    assert.ok(ids.includes('gateway/hive-smart'), 'hive-smart alias present');
    assert.ok(
      grouped.gateway.every(e => e.provider === 'gateway' && e.source === 'gateway'),
      'every alias entry is tagged provider/source = gateway',
    );
  });
});
