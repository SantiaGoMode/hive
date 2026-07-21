const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const http = require('http');
const db = require('../db');

// Build a minimal app with just the colony router (no WS, no scheduler, no sandbox warmup)
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/colony', require('../routes/colony'));
  return app;
}

const app = buildApp();
const created = [];

after(() => {
  for (const id of created) {
    try { db.prepare('DELETE FROM colonies WHERE id=?').run(id); } catch {}
  }
});

describe('GET /api/colony', () => {
  it('returns 200 with an array', async () => {
    const res = await request(app).get('/api/colony');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });
});

describe('GET /api/colony/recipes', () => {
  it('returns operator-selectable recipes', async () => {
    const res = await request(app).get('/api/colony/recipes');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.some(recipe => recipe.id === 'research_brief'));
    assert.ok(res.body.some(recipe => recipe.id === 'custom_auto'));
  });
});

describe('GET /api/colony/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/colony/no-such-colony-xyz');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  it('returns 200 with colony data for a valid id', async () => {
    // Insert directly so we don't trigger runColony
    const { createColony } = require('../lib/colonyRunner');
    const id = createColony('Route get test', 'llama3');
    created.push(id);

    const res = await request(app).get(`/api/colony/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, id);
    assert.equal(res.body.goal, 'Route get test');
    assert.ok(Array.isArray(res.body.log), 'log should be an array');
    assert.ok(Array.isArray(res.body.agents), 'agents should be an array');
    assert.ok(Array.isArray(res.body.agent_ids), 'agent_ids should be an array');
  });
});

describe('POST /api/colony/:id/stop', () => {
  it('returns 404 for an unknown colony id', async () => {
    const res = await request(app).post('/api/colony/no-such-colony-xyz/stop');
    assert.equal(res.status, 404);
  });

  it('reconciles a stale running row (no live run) to stopped', async () => {
    // Colonies are created with status='running'. With no live run in the
    // runner registry, /stop must reconcile the DB row so the UI never shows
    // a phantom run that cannot be stopped.
    const { createColony, getColony } = require('../lib/colonyRunner');
    const id = createColony('Stop test colony — stale running', 'llama3');
    created.push(id);

    const res = await request(app).post(`/api/colony/${id}/stop`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.stopped, true);
    assert.equal(getColony(id).status, 'stopped');
  });

  it('returns stopped:false for a colony that already finished', async () => {
    const { createColony } = require('../lib/colonyRunner');
    const db = require('../db');
    const id = createColony('Stop test colony — done', 'llama3');
    created.push(id);
    db.prepare("UPDATE colonies SET status='done' WHERE id=?").run(id);

    const res = await request(app).post(`/api/colony/${id}/stop`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.stopped, false);
  });
});

describe('DELETE /api/colony/:id', () => {
  it('returns 200 and removes the colony', async () => {
    const { createColony, getColony } = require('../lib/colonyRunner');
    const id = createColony('Delete route test', 'llama3');
    // Don't push to created[] — we're deleting it here

    const res = await request(app).delete(`/api/colony/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const colony = getColony(id);
    assert.equal(colony, null, 'Colony should be gone from DB after DELETE');
  });

  it('still returns 200 for a non-existent id (graceful)', async () => {
    const res = await request(app).delete('/api/colony/ghost-colony-xyz');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});

describe('POST /api/colony — validation', () => {
  it('returns 400 when goal is missing', async () => {
    const res = await request(app)
      .post('/api/colony')
      .send({ model: 'llama3' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when model is missing', async () => {
    const res = await request(app)
      .post('/api/colony')
      .send({ goal: 'Some goal' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when goal is blank whitespace', async () => {
    const res = await request(app)
      .post('/api/colony')
      .send({ goal: '   ', model: 'llama3' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when recipe_id is unknown', async () => {
    const res = await request(app)
      .post('/api/colony')
      .send({ goal: 'Some goal', model: 'llama3', recipe_id: 'not-a-real-recipe' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });
});

// ── Regression: POST /api/colony must not kill the run from req.on('close') ──
// In Express 5, req 'close' fires as soon as the request body has been fully
// consumed, which is nearly instant for a small POST. An earlier version of
// this route listened to req 'close' and aborted the AbortController there,
// which killed every colony within ~20ms — the client only ever saw the
// orchestrator being created before the run was silently stopped. The fix was
// to listen on res 'close' with a !res.writableFinished guard instead.
//
// This test spins up a real HTTP server, launches a durable run, then closes the
// observer stream. The job must remain queued/running until an explicit stop;
// transport lifetime no longer owns execution.
describe('POST /api/colony — observer disconnect does not own the durable run', () => {
  let server;
  let baseUrl;
  let fakeOllama;
  let fakeOllamaUrl;
  const createdIds = [];

  before(async () => {
    // Fake Ollama
    await new Promise(resolve => {
      const s = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          // Preflight endpoints
          if (req.url === '/api/tags') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ models: [{ name: 'fake-model' }] }));
            return;
          }
          if (req.url === '/api/show') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.write(JSON.stringify({
            message: { content: 'GOAL ACHIEVED: done.', tool_calls: [] },
            done: true,
          }) + '\n');
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => {
        fakeOllama = s;
        fakeOllamaUrl = `http://127.0.0.1:${s.address().port}`;
        resolve();
      });
    });
    // Tests run against a throwaway DB (see server/tests/setup.js) so writing
    // the fake URL here can't leak into the user's real ~/.hive/hive.db.
    db.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('ollama_url', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(fakeOllamaUrl);

    // Real HTTP server hosting the colony router
    const expressApp = buildApp();
    server = http.createServer(expressApp);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    for (const id of createdIds) {
      try {
        const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(id);
        if (row) {
          for (const aid of JSON.parse(row.agent_ids || '[]')) {
            try { db.prepare('DELETE FROM agents WHERE id=?').run(aid); } catch {}
          }
        }
        db.prepare('DELETE FROM colonies WHERE id=?').run(id);
      } catch {}
    }
    server.closeAllConnections?.();
    fakeOllama.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => fakeOllama.close(resolve));
  });

  it('keeps the job alive after the SSE observer disconnects', async () => {
    const response = await fetch(`${baseUrl}/api/colony`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Route regression test', model: 'fake-model', recipe_id: 'custom_auto' }),
    });

    assert.equal(response.status, 200, 'SSE endpoint should return 200');
    assert.ok(response.headers.get('content-type')?.includes('text/event-stream'), 'should be an SSE response');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let colonyId = null;

    // Read only until the durable run id is announced, then deliberately drop
    // the HTTP observer while execution continues in colonyJobs.
    while (!colonyId) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 2);
        if (!frame.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(frame.slice(6));
          if (ev.type === 'colony_id') colonyId = ev.colonyId;
        } catch {}
      }
    }
    assert.ok(colonyId, 'should have received colony_id frame');
    createdIds.push(colonyId);
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 50));

    const afterDisconnect = db.prepare('SELECT status FROM colonies WHERE id=?').get(colonyId);
    assert.notEqual(afterDisconnect.status, 'stopped', 'closing the observer must not stop durable execution');

    const stopped = await fetch(`${baseUrl}/api/colony/${colonyId}/stop`, { method: 'POST' });
    assert.equal(stopped.status, 200);
  });
});
