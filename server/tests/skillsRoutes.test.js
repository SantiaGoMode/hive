// HTTP tests for /api/skills (issue #47). Pure DB CRUD — no external services.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../db');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/skills'), '/api/skills');
const created = [];
after(() => { for (const id of created) { try { db.prepare('DELETE FROM skills WHERE id=?').run(id); } catch {} } });

describe('Skills API', () => {
  it('lists skills', async () => {
    const res = await request(app).get('/api/skills').expect(200);
    assert.ok(Array.isArray(res.body.skills));
  });

  it('rejects create without a name', async () => {
    const res = await request(app).post('/api/skills').send({ description: 'x' }).expect(400);
    assert.match(res.body.error, /name is required/i);
  });

  it('creates a skill', async () => {
    const name = `Test Skill ${Date.now()}`;
    const res = await request(app).post('/api/skills').send({ name, description: 'desc', instructions: 'do it' }).expect(201);
    created.push(res.body.id);
    assert.equal(res.body.name, name);
  });

  it('rejects a duplicate name with 409', async () => {
    const name = `Dup Skill ${Date.now()}`;
    const a = await request(app).post('/api/skills').send({ name }).expect(201);
    created.push(a.body.id);
    const res = await request(app).post('/api/skills').send({ name }).expect(409);
    assert.match(res.body.error, /already exists/i);
  });

  it('updates a skill', async () => {
    const a = await request(app).post('/api/skills').send({ name: `Edit ${Date.now()}` }).expect(201);
    created.push(a.body.id);
    const res = await request(app).put(`/api/skills/${a.body.id}`).send({ description: 'updated' }).expect(200);
    assert.equal(res.body.description, 'updated');
  });

  it('404s updating a missing skill', async () => {
    await request(app).put('/api/skills/nope-does-not-exist').send({ description: 'x' }).expect(404);
  });

  it('deletes a skill (and 404s the second time)', async () => {
    const a = await request(app).post('/api/skills').send({ name: `Del ${Date.now()}` }).expect(201);
    await request(app).delete(`/api/skills/${a.body.id}`).expect(200);
    await request(app).delete(`/api/skills/${a.body.id}`).expect(404);
  });

  it('returns tool-options (built-in + MCP)', async () => {
    const res = await request(app).get('/api/skills/tool-options').expect(200);
    assert.ok(Array.isArray(res.body.tools));
  });
});
