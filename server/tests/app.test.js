const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');

describe('HTTP app composition', () => {
  it('keeps liveness separate from readiness and applies security headers', async () => {
    let ready = false;
    const { app } = createApp({ isReady: () => ready });
    const live = await request(app).get('/healthz').expect(200);
    assert.equal(live.body.ok, true);
    assert.equal(live.headers['x-content-type-options'], 'nosniff');
    assert.equal(live.headers['x-frame-options'], 'DENY');
    assert.match(live.headers['content-security-policy'], /frame-ancestors 'none'/);

    const unavailable = await request(app).get('/readyz').expect(503);
    assert.equal(unavailable.body.ok, false);
    ready = true;
    const available = await request(app).get('/readyz').expect(200);
    assert.equal(available.body.ok, true);
  });

  it('does not expose the Express fingerprint', async () => {
    const { app } = createApp({ isReady: () => true });
    const response = await request(app).get('/healthz').expect(200);
    assert.equal(response.headers['x-powered-by'], undefined);
  });
});
