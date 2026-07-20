const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const cors = require('cors');
const request = require('supertest');
const WebSocket = require('ws');
const {
  assertCanExposePublicly,
  createCorsOptions,
  createMutatingRateLimiter,
  createOriginGuard,
  requireHiveAuth,
} = require('../lib/auth');
const { createWebSocketServer } = require('../lib/websocket');

function makeApp(options = {}) {
  const app = express();
  app.use(createOriginGuard(options));
  app.use(cors(createCorsOptions(options)));
  app.use(express.json());
  app.use('/api', requireHiveAuth(options));
  app.use('/api', createMutatingRateLimiter({ ...options, limit: options.limit || 50, windowMs: 60_000 }));
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  app.post('/api/update', (req, res) => res.json({ ok: true }));
  app.post('/api/webhooks/incoming/:id', (req, res) => res.status(202).json({ ok: true }));
  return app;
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function connectWebSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const { protocols, ...wsOptions } = options;
    const ws = protocols ? new WebSocket(url, protocols, wsOptions) : new WebSocket(url, wsOptions);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket timed out'));
    }, 1000);

    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ ws, statusCode: 101 });
    });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer);
      resolve({ ws, statusCode: res.statusCode });
    });
    ws.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('API hardening middleware', () => {
  it('allows configured origins and rejects unknown browser origins', async () => {
    const app = makeApp({ token: 'secret-token', allowedOrigins: ['http://app.test'] });

    const allowed = await request(app)
      .get('/api/ping')
      .set('Origin', 'http://app.test')
      .set('x-hive-auth-token', 'secret-token')
      .expect(200);
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://app.test');

    await request(app)
      .get('/api/ping')
      .set('Origin', 'http://evil.test')
      .set('x-hive-auth-token', 'secret-token')
      .expect(403);
  });

  it('requires a valid Hive auth token for protected API routes', async () => {
    const app = makeApp({ token: 'secret-token' });

    await request(app).get('/api/ping').expect(401);
    await request(app).get('/api/ping').set('x-hive-auth-token', 'wrong').expect(401);
    await request(app).get('/api/ping').set('Authorization', 'Bearer secret-token').expect(200);
    await request(app).get('/api/ping?hive_token=secret-token').expect(401);
  });

  it('keeps localhost-only development usable when no auth token is configured', async () => {
    const app = makeApp({ token: '' });

    await request(app)
      .get('/api/ping')
      .set('Origin', 'http://localhost:5173')
      .expect(200);
  });

  it('exempts incoming webhooks from the Hive UI token gate', async () => {
    const app = makeApp({ token: 'secret-token' });

    await request(app)
      .post('/api/webhooks/incoming/demo')
      .send({ ok: true })
      .expect(202);
  });

  it('rate limits mutating protected API routes', async () => {
    const app = makeApp({ token: 'secret-token', limit: 2 });

    await request(app).post('/api/update').set('x-hive-auth-token', 'secret-token').send({ n: 1 }).expect(200);
    await request(app).post('/api/update').set('x-hive-auth-token', 'secret-token').send({ n: 2 }).expect(200);
    await request(app).post('/api/update').set('x-hive-auth-token', 'secret-token').send({ n: 3 }).expect(429);
  });

  it('refuses public exposure when Hive auth is not configured', () => {
    assert.throws(
      () => assertCanExposePublicly({ token: '' }),
      /Hive auth must be configured/
    );
    assert.doesNotThrow(() => assertCanExposePublicly({ token: 'secret-token' }));
  });
});

describe('WebSocket hardening', () => {
  const servers = [];

  after(async () => {
    await Promise.all(servers.map(server => closeServer(server)));
  });

  it('rejects unauthorized chat upgrades before accepting the socket', async () => {
    const server = http.createServer();
    createWebSocketServer(server, { token: 'secret-token', allowedOrigins: ['http://localhost:5173'] });
    servers.push(server);
    const port = await listen(server);

    const missing = await connectWebSocket(`ws://127.0.0.1:${port}/ws/chat/agent-1`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(missing.statusCode, 401);

    const protocol = `hive-auth.${Buffer.from('secret-token').toString('base64url')}`;
    const badOrigin = await connectWebSocket(`ws://127.0.0.1:${port}/ws/chat/agent-1`, {
      headers: { Origin: 'http://evil.test' },
      protocols: [protocol],
    });
    assert.equal(badOrigin.statusCode, 403);
  });

  it('accepts authorized chat upgrades', async () => {
    const server = http.createServer();
    createWebSocketServer(server, { token: 'secret-token', allowedOrigins: ['http://localhost:5173'] });
    servers.push(server);
    const port = await listen(server);

    const protocol = `hive-auth.${Buffer.from('secret-token').toString('base64url')}`;
    const { ws, statusCode } = await connectWebSocket(`ws://127.0.0.1:${port}/ws/chat/agent-1`, {
      headers: { Origin: 'http://localhost:5173' },
      protocols: [protocol],
    });
    assert.equal(statusCode, 101);
    ws.close();
  });
});
