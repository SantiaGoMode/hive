// HTTP tests for /api/agents (issue #47). Agents are file-based under the temp
// HIVE_HOME from setup.js, so create/read/delete is safe and isolated.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/agents'), '/api/agents');
const created = [];
after(async () => { for (const id of created) { try { await request(app).delete(`/api/agents/${id}`); } catch {} } });

async function makeAgent(extra = {}) {
  const res = await request(app).post('/api/agents').send({ name: `Agent ${Date.now()}-${Math.round(performance.now())}`, ...extra }).expect(201);
  created.push(res.body.id);
  return res.body;
}

describe('Agents API', () => {
  it('lists agents', async () => {
    const res = await request(app).get('/api/agents').expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it('rejects create without a name', async () => {
    const res = await request(app).post('/api/agents').send({ model: 'llama3' }).expect(400);
    assert.match(res.body.error, /name is required/i);
  });

  it('creates an agent and fetches it by id', async () => {
    const a = await makeAgent({ model: 'llama3.1:8b' });
    assert.ok(a.id);
    const got = await request(app).get(`/api/agents/${a.id}`).expect(200);
    assert.equal(got.body.name, a.name);
  });

  it('404s an unknown agent', async () => {
    await request(app).get('/api/agents/no-such-agent').expect(404);
  });

  it('updates an agent', async () => {
    const a = await makeAgent();
    const upd = await request(app).put(`/api/agents/${a.id}`).send({ description: 'updated desc' }).expect(200);
    assert.equal(upd.body.description, 'updated desc');
  });

  it('round-trips agent memory (validation + write + read)', async () => {
    const a = await makeAgent();
    await request(app).put(`/api/agents/${a.id}/memory`).send({}).expect(400); // content required
    await request(app).put(`/api/agents/${a.id}/memory`).send({ content: 'remember this' }).expect(200);
    const got = await request(app).get(`/api/agents/${a.id}/memory`).expect(200);
    assert.equal(got.body.content, 'remember this');
  });

  it('deletes an agent', async () => {
    const a = await makeAgent();
    await request(app).delete(`/api/agents/${a.id}`).expect(200);
    await request(app).get(`/api/agents/${a.id}`).expect(404);
  });
});
