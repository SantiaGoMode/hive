// HTTP tests for /api/system/metrics (issue #31). Mounts the system router on a
// bare express app (no auth middleware) and exercises it with supertest.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const systemRouter = require('../routes/system');

const app = express();
app.use(express.json());
app.use('/api/system', systemRouter);

describe('GET /api/system/metrics', () => {
  it('returns an operational snapshot with the expected shape', async () => {
    const res = await request(app).get('/api/system/metrics');
    assert.equal(res.status, 200);
    const b = res.body;
    assert.equal(typeof b.uptime_s, 'number');
    assert.equal(typeof b.pid, 'number');
    assert.match(b.node_version, /^v\d/);
    assert.ok('memory' in b);
    assert.ok('active_colony_runs' in b);
    assert.ok('scheduled_tasks' in b);
    assert.equal(typeof b.staff_scheduler.started, 'boolean');
    assert.equal(typeof b.staff_scheduler.ticking, 'boolean');
    assert.equal(typeof b.ollama.reachable, 'boolean');
    assert.equal(typeof b.ollama.url, 'string');
    assert.equal(typeof b.ollama.loaded_models, 'number');
    assert.equal(typeof b.gateway.enabled, 'boolean');
    assert.ok(Array.isArray(b.recent_logs));
  });

  it('never leaks gateway url/key or api keys', async () => {
    const saved = { url: process.env.LLM_GATEWAY_URL, key: process.env.LLM_GATEWAY_KEY };
    process.env.LLM_GATEWAY_URL = 'http://secret-gw-host:4000/v1';
    process.env.LLM_GATEWAY_KEY = 'sk-supersecretkey123';
    try {
      const res = await request(app).get('/api/system/metrics');
      const blob = JSON.stringify(res.body);
      assert.equal(res.body.gateway.enabled, true);      // it IS configured…
      assert.equal(res.body.gateway.url, undefined);     // …but the url is never returned
      assert.ok(!blob.includes('secret-gw-host'), 'gateway host not leaked');
      assert.ok(!blob.includes('sk-supersecretkey123'), 'gateway key not leaked');
    } finally {
      if (saved.url === undefined) delete process.env.LLM_GATEWAY_URL; else process.env.LLM_GATEWAY_URL = saved.url;
      if (saved.key === undefined) delete process.env.LLM_GATEWAY_KEY; else process.env.LLM_GATEWAY_KEY = saved.key;
    }
  });

  it('surfaces recent swallowed errors in recent_logs', async () => {
    const { logSwallowed } = require('../lib/logSwallowed');
    require('../lib/logger')._resetLogs();
    logSwallowed('systemRoutesTest:probe', new Error('synthetic failure'));
    const res = await request(app).get('/api/system/metrics');
    const hit = res.body.recent_logs.find(l => l.event === 'systemRoutesTest:probe');
    assert.ok(hit, 'swallowed error appears in metrics ring buffer');
    assert.equal(hit.component, 'swallowed');
  });
});

describe('other /api/system endpoints (#47)', () => {
  it('POST /model/stop requires a model', async () => {
    const res = await request(app).post('/api/system/model/stop').send({}).expect(400);
    assert.match(res.body.error, /model is required/i);
  });

  it('GET /ngrok/status reports not-running by default', async () => {
    const res = await request(app).get('/api/system/ngrok/status').expect(200);
    assert.equal(res.body.running, false);
  });

  it('POST /ngrok/start 400s when no authtoken is configured', async () => {
    const saved = process.env.NGROK_AUTHTOKEN;
    delete process.env.NGROK_AUTHTOKEN;
    try {
      const res = await request(app).post('/api/system/ngrok/start').expect(400);
      assert.match(res.body.error, /Auth Token is not configured/i);
    } finally {
      if (saved === undefined) delete process.env.NGROK_AUTHTOKEN; else process.env.NGROK_AUTHTOKEN = saved;
    }
  });
});
