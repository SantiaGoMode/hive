// HTTP tests for /api/system/metrics (issue #31). Mounts the system router on a
// bare express app (no auth middleware) and exercises it with supertest.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const db = require('../db');
const systemRouter = require('../routes/system');
const gatewayHealth = require('../lib/gatewayHealth');
const gatewaySpend = require('../lib/gatewaySpend');

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
    assert.equal(typeof b.scheduler_lifecycle.scheduler.running, 'boolean');
    assert.equal(typeof b.scheduler_lifecycle.scheduler.tick_count, 'number');
    assert.equal(typeof b.ollama.reachable, 'boolean');
    assert.equal(typeof b.ollama.url, 'string');
    assert.equal(typeof b.ollama.loaded_models, 'number');
    assert.ok(Array.isArray(b.ollama.loaded_model_details));
    assert.equal(typeof b.gateway.enabled, 'boolean');
    assert.ok('reachable' in b.gateway);
    assert.equal(typeof b.gateway.message, 'string');
    assert.equal(typeof b.gateway.spend.enabled, 'boolean');
    assert.ok(Array.isArray(b.recent_logs));
  });

  it('returns sanitized loaded Ollama model details', async () => {
    const savedFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [{
              name: 'llama3.2:3b',
              model: 'llama3.2:3b',
              size: 2019393189,
              size_vram: 1024,
              expires_at: '2026-07-01T12:00:00Z',
              details: { parameter_size: '3.2B', quantization_level: 'Q4_K_M', family: 'llama' },
            }],
          }),
        };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    };
    try {
      const res = await request(app).get('/api/system/metrics').expect(200);
      assert.equal(res.body.ollama.reachable, true);
      assert.equal(res.body.ollama.loaded_models, 1);
      assert.deepEqual(res.body.ollama.loaded_model_details, [{
        name: 'llama3.2:3b',
        model: 'llama3.2:3b',
        size: 2019393189,
        size_vram: 1024,
        expires_at: '2026-07-01T12:00:00Z',
        parameter_size: '3.2B',
        quantization_level: 'Q4_K_M',
      }]);
    } finally {
      global.fetch = savedFetch;
    }
  });

  it('never leaks gateway url/key or api keys', async () => {
    const saved = { url: process.env.LLM_GATEWAY_URL, key: process.env.LLM_GATEWAY_KEY };
    const savedFetch = global.fetch;
    process.env.LLM_GATEWAY_URL = 'http://secret-gw-host:4000/v1';
    process.env.LLM_GATEWAY_KEY = 'sk-supersecretkey123';
    gatewayHealth._resetForTests();
    global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
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
      global.fetch = savedFetch;
      gatewayHealth._resetForTests();
      gatewaySpend._resetForTests();
    }
  });

  it('reports gateway reachability from the health probe', async () => {
    const saved = { url: process.env.LLM_GATEWAY_URL, key: process.env.LLM_GATEWAY_KEY };
    const savedFetch = global.fetch;
    process.env.LLM_GATEWAY_URL = 'http://gateway-ok:4000/v1';
    process.env.LLM_GATEWAY_KEY = 'sk-test';
    gatewayHealth._resetForTests();
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('/health')) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 503, json: async () => ({ models: [] }) };
    };
    try {
      const res = await request(app).get('/api/system/metrics');
      assert.equal(res.body.gateway.enabled, true);
      assert.equal(res.body.gateway.reachable, true);
      assert.equal(res.body.gateway.message, 'Gateway reachable');
      assert.ok(seen.some(url => url === 'http://gateway-ok:4000/health/readiness'));
      assert.equal(res.body.gateway.url, undefined);
    } finally {
      if (saved.url === undefined) delete process.env.LLM_GATEWAY_URL; else process.env.LLM_GATEWAY_URL = saved.url;
      if (saved.key === undefined) delete process.env.LLM_GATEWAY_KEY; else process.env.LLM_GATEWAY_KEY = saved.key;
      global.fetch = savedFetch;
      gatewayHealth._resetForTests();
      gatewaySpend._resetForTests();
    }
  });

  it('returns sanitized per-agent gateway spend summaries', async () => {
    const saved = { url: process.env.LLM_GATEWAY_URL, key: process.env.LLM_GATEWAY_KEY };
    const savedFetch = global.fetch;
    process.env.LLM_GATEWAY_URL = 'http://gateway-spend:4000/v1';
    process.env.LLM_GATEWAY_KEY = 'sk-spend-secret';
    gatewayHealth._resetForTests();
    gatewaySpend._resetForTests();
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('/health')) return { ok: true, status: 200, json: async () => ({}) };
      if (String(url).includes('/spend/logs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                spend: 0.0125,
                total_tokens: 1250,
                cache_hit: true,
                metadata: { spend_logs_metadata: { agent_id: 'agent-1', agent_name: 'Planner' } },
              },
              {
                spend: 0.01,
                prompt_tokens: 100,
                completion_tokens: 200,
                metadata: JSON.stringify({ spend_logs_metadata: { agent_id: 'agent-1', agent_name: 'Planner' } }),
              },
            ],
          }),
        };
      }
      return { ok: false, status: 503, json: async () => ({ models: [] }) };
    };
    try {
      const res = await request(app).get('/api/system/metrics');
      assert.equal(res.status, 200);
      assert.equal(res.body.gateway.spend.enabled, true);
      assert.equal(res.body.gateway.spend.persistence.spend_logs_reachable, true);
      assert.equal(res.body.gateway.spend.persistence.observed_rows, 2);
      assert.equal(res.body.gateway.spend.totals.calls, 2);
      assert.equal(res.body.gateway.spend.totals.tokens, 1550);
      assert.equal(res.body.gateway.spend.totals.cache_hit_rate, 0.5);
      assert.equal(res.body.gateway.spend.agents[0].agent_id, 'agent-1');
      assert.equal(res.body.gateway.spend.agents[0].spend_usd, 0.0225);
      assert.ok(seen.some(url => url === 'http://gateway-spend:4000/spend/logs?limit=500'));
      const blob = JSON.stringify(res.body);
      assert.ok(!blob.includes('gateway-spend'), 'gateway host not leaked');
      assert.ok(!blob.includes('sk-spend-secret'), 'gateway key not leaked');
    } finally {
      if (saved.url === undefined) delete process.env.LLM_GATEWAY_URL; else process.env.LLM_GATEWAY_URL = saved.url;
      if (saved.key === undefined) delete process.env.LLM_GATEWAY_KEY; else process.env.LLM_GATEWAY_KEY = saved.key;
      global.fetch = savedFetch;
      gatewayHealth._resetForTests();
      gatewaySpend._resetForTests();
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
  it('GET /diagnostics returns a redacted support bundle', async () => {
    const logger = require('../lib/logger');
    logger._resetLogs();
    logger.logger.error('diagnostics-test', 'failure', {
      apiKey: 'must-not-leak',
      authorization: 'Bearer must-also-not-leak',
    });
    const res = await request(app).get('/api/system/diagnostics').expect(200);
    const blob = JSON.stringify(res.body);
    assert.equal(res.body.format, 'hive-support-diagnostics');
    assert.equal(typeof res.body.hive.schema_version, 'number');
    assert.equal(res.body.database.integrity.ok, true);
    assert.equal(res.body.database.pragmas.foreign_keys, true);
    assert.equal(typeof res.body.database.colony_event_state.runs_without_events, 'number');
    assert.equal(res.body.compatibility, undefined);
    assert.match(res.headers['content-disposition'], /^attachment;/);
    assert.ok(!blob.includes('must-not-leak'));
    assert.ok(!blob.includes('must-also-not-leak'));
    assert.ok(!blob.includes(process.env.HIVE_DB_PATH));
  });

  it('lists automation jobs without payloads and replays only dead letters', async () => {
    const id = `system-job-${Date.now()}`;
    db.prepare(`
      INSERT INTO automation_jobs
        (id, kind, source, idempotency_key, payload, policy, status, attempt, max_attempts)
      VALUES (?, 'system-test-unregistered', 'test', ?, ?, '{}', 'dead_letter', 1, 1)
    `).run(id, id, JSON.stringify({ secretPrompt: 'do not expose this' }));
    try {
      const listed = await request(app).get('/api/system/automation/jobs?status=dead_letter').expect(200);
      const row = listed.body.jobs.find(job => job.id === id);
      assert.ok(row);
      assert.equal(row.has_payload, true);
      assert.equal(row.payload, undefined);
      assert.ok(!JSON.stringify(listed.body).includes('do not expose this'));
      await request(app).post(`/api/system/automation/jobs/${id}/replay`).expect(200);
      assert.equal(db.prepare('SELECT status FROM automation_jobs WHERE id=?').get(id).status, 'queued');
      await request(app).post(`/api/system/automation/jobs/${id}/replay`).expect(409);
    } finally {
      db.prepare('DELETE FROM automation_jobs WHERE id=?').run(id);
    }
  });

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
