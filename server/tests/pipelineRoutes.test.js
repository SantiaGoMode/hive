// HTTP tests for /api/pipelines (issue #47). CRUD + validation; the SSE run
// endpoints are exercised only on their early validation paths (which return
// before any agent execution / streaming begins).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../db');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/pipelines'), '/api/pipelines');
const created = [];
after(() => { for (const id of created) { try { db.prepare('DELETE FROM pipelines WHERE id=?').run(id); db.prepare('DELETE FROM pipeline_runs WHERE pipeline_id=?').run(id); } catch {} } });

async function makePipeline(steps = []) {
  const res = await request(app).post('/api/pipelines').send({ name: `P ${Date.now()}-${Math.round(performance.now())}`, steps }).expect(201);
  created.push(res.body.id);
  return res.body;
}

describe('Pipelines API', () => {
  it('lists pipelines', async () => {
    const res = await request(app).get('/api/pipelines').expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it('rejects create without a name', async () => {
    const res = await request(app).post('/api/pipelines').send({ steps: [] }).expect(400);
    assert.match(res.body.error, /name is required/i);
  });

  it('creates a pipeline and parses its steps', async () => {
    const p = await makePipeline([{ label: 'one', agent_id: '', prompt: 'do {input}' }]);
    assert.ok(Array.isArray(p.steps));
    assert.equal(p.steps[0].label, 'one');
  });

  it('gets a pipeline by id and 404s a missing one', async () => {
    const p = await makePipeline();
    await request(app).get(`/api/pipelines/${p.id}`).expect(200);
    await request(app).get('/api/pipelines/missing-id').expect(404);
  });

  it('updates and deletes a pipeline', async () => {
    const p = await makePipeline();
    const upd = await request(app).put(`/api/pipelines/${p.id}`).send({ name: 'Renamed', steps: [] }).expect(200);
    assert.equal(upd.body.name, 'Renamed');
    await request(app).delete(`/api/pipelines/${p.id}`).expect(200);
  });

  it('returns runs for a pipeline', async () => {
    const p = await makePipeline();
    const res = await request(app).get(`/api/pipelines/${p.id}/runs`).expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it('404s running a missing pipeline, before any streaming', async () => {
    const res = await request(app).post('/api/pipelines/missing-id/run').send({ input: 'hi' }).expect(404);
    assert.match(res.body.error, /not found/i);
  });

  it('rejects a run with empty input', async () => {
    const p = await makePipeline([{ label: 'one', prompt: 'x' }]);
    const res = await request(app).post(`/api/pipelines/${p.id}/run`).send({ input: '   ' }).expect(400);
    assert.match(res.body.error, /input is required/i);
  });

  it('rejects running a pipeline with no steps', async () => {
    const p = await makePipeline([]);
    const res = await request(app).post(`/api/pipelines/${p.id}/run`).send({ input: 'go' }).expect(400);
    assert.match(res.body.error, /no steps/i);
  });
});
