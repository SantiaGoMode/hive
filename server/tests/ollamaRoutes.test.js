// HTTP tests for /api/ollama (issue #47). Uses a fake local Ollama server for
// the success path and an unreachable URL for the error path — no real Ollama.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('supertest');
const db = require('../db');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/ollama'), '/api/ollama');

let server, baseUrl, origUrl;
const sockets = new Set();

function setOllamaUrl(url) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('ollama_url', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(url);
}

before(async () => {
  origUrl = db.prepare("SELECT value FROM app_settings WHERE key='ollama_url'").get()?.value || null;
  server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'fake-model:latest', model: 'fake-model:latest', size: 123 }] }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  for (const s of sockets) s.destroy();
  server.close();
  if (origUrl === null) db.prepare("DELETE FROM app_settings WHERE key='ollama_url'").run();
  else setOllamaUrl(origUrl);
});

describe('Ollama API', () => {
  it('lists models from the (fake) Ollama server', async () => {
    setOllamaUrl(baseUrl);
    const res = await request(app).get('/api/ollama/models').expect(200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body[0].name, 'fake-model:latest');
  });

  it('returns 503 when Ollama is unreachable', async () => {
    setOllamaUrl('http://127.0.0.1:1'); // nothing listening → connection refused
    const res = await request(app).get('/api/ollama/models').expect(503);
    assert.match(res.body.error, /not reachable/i);
  });

  it('rejects a pull with no model name', async () => {
    const res = await request(app).post('/api/ollama/pull').send({}).expect(400);
    assert.match(res.body.error, /name required/i);
  });
});
