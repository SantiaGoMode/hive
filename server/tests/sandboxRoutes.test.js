// HTTP tests for /api/sandbox (issue #47). Covers request validation and
// workspace path-containment (issue #21) at the HTTP level — file read/write
// happens under the temp HIVE_HOME, with NO Docker (start/reset/proxy skipped).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/sandbox'), '/api/sandbox');
const AGENT = 'route-test-agent';

describe('Sandbox API', () => {
  it('requires a path query param to read a file', async () => {
    const res = await request(app).get(`/api/sandbox/${AGENT}/file`).expect(400);
    assert.match(res.body.error, /path required/i);
  });

  it('requires a path query param to write a file', async () => {
    await request(app).put(`/api/sandbox/${AGENT}/file`).send({ content: 'x' }).expect(400);
  });

  it('blocks path traversal outside the workspace (403)', async () => {
    const res = await request(app)
      .get(`/api/sandbox/${AGENT}/file`)
      .query({ path: '../../../../etc/passwd' })
      .expect(403);
    assert.equal(res.body.error, 'forbidden');
  });

  it('writes and reads back a file within the workspace', async () => {
    await request(app).put(`/api/sandbox/${AGENT}/file`).query({ path: 'notes/todo.txt' }).send({ content: 'hello sandbox' }).expect(200);
    const res = await request(app).get(`/api/sandbox/${AGENT}/file`).query({ path: 'notes/todo.txt' }).expect(200);
    assert.equal(res.body.content, 'hello sandbox');
  });

  it('404s reading a missing file in a valid workspace', async () => {
    await request(app).get(`/api/sandbox/${AGENT}/file`).query({ path: 'does-not-exist.txt' }).expect(404);
  });
});
