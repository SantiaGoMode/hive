// HTTP tests for /api/mcp (issue #47). mcpManager connect/disconnect are stubbed
// (save/restore) so no subprocesses are spawned; covers validation + DB CRUD.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../db');
const mcpManager = require('../lib/mcpClient');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/mcp'), '/api/mcp');
const created = [];
const orig = {};

before(() => {
  for (const fn of ['reconnect', 'disconnect']) { orig[fn] = mcpManager[fn]; mcpManager[fn] = async () => {}; }
});
after(() => {
  for (const fn of Object.keys(orig)) mcpManager[fn] = orig[fn];
  for (const id of created) { try { db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id); } catch {} }
});

describe('MCP API', () => {
  it('lists mcp servers', async () => {
    const res = await request(app).get('/api/mcp').expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it('rejects create without a name', async () => {
    const res = await request(app).post('/api/mcp').send({ transport: 'stdio', command: 'x' }).expect(400);
    assert.match(res.body.error, /name is required/i);
  });

  it('requires a command for stdio transport', async () => {
    const res = await request(app).post('/api/mcp').send({ name: 'S', transport: 'stdio' }).expect(400);
    assert.match(res.body.error, /command is required/i);
  });

  it('requires a url for http transport', async () => {
    const res = await request(app).post('/api/mcp').send({ name: 'S', transport: 'http' }).expect(400);
    assert.match(res.body.error, /url is required/i);
  });

  it('creates a disabled stdio server (no reconnect) and deletes it', async () => {
    const res = await request(app).post('/api/mcp').send({ name: `srv-${Date.now()}`, transport: 'stdio', command: 'echo', enabled: false }).expect(201);
    created.push(res.body.id);
    assert.ok(res.body.id);
    await request(app).delete(`/api/mcp/${res.body.id}`).expect(200);
  });
});
