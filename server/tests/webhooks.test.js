const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const db = require('../db');
const request = require('supertest');
const express = require('express');
const webhooksRouter = require('../routes/webhooks');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use('/api/webhooks', webhooksRouter);

describe('Webhooks API', () => {
  let webhookId;
  let envWebhookId;
  let envSignedWebhookId;
  let disabledWebhookId;
  const oldWebhookSecret = process.env.HIVE_TEST_WEBHOOK_SECRET;

  after(() => {
    try {
      if (webhookId) {
        db.prepare('DELETE FROM webhook_events WHERE webhook_id = ?').run(webhookId);
        db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId);
      }
      if (envWebhookId) {
        db.prepare('DELETE FROM webhook_events WHERE webhook_id = ?').run(envWebhookId);
        db.prepare('DELETE FROM webhooks WHERE id = ?').run(envWebhookId);
      }
      if (envSignedWebhookId) {
        db.prepare('DELETE FROM webhook_events WHERE webhook_id = ?').run(envSignedWebhookId);
        db.prepare('DELETE FROM webhooks WHERE id = ?').run(envSignedWebhookId);
      }
      if (disabledWebhookId) {
        db.prepare('DELETE FROM webhook_events WHERE webhook_id = ?').run(disabledWebhookId);
        db.prepare('DELETE FROM webhooks WHERE id = ?').run(disabledWebhookId);
      }
      if (oldWebhookSecret === undefined) delete process.env.HIVE_TEST_WEBHOOK_SECRET;
      else process.env.HIVE_TEST_WEBHOOK_SECRET = oldWebhookSecret;
    } catch (e) {}
  });

  it('creates a webhook', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ name: 'Test Webhook', description: 'For tests', secret: 'test-secret' })
      .expect(201);
    
    assert.equal(res.body.name, 'Test Webhook');
    // Raw secrets are never echoed back — only a masked placeholder.
    assert.equal(res.body.secret, '••••••••cret');
    webhookId = res.body.id;
  });

  it('requires a secret before a webhook can be enabled', async () => {
    await request(app)
      .post('/api/webhooks')
      .send({ name: 'Unsafe Webhook', enabled: true })
      .expect(400);

    const created = await request(app)
      .post('/api/webhooks')
      .send({ name: 'Disabled Webhook', enabled: false })
      .expect(201);
    disabledWebhookId = created.body.id;

    await request(app)
      .put(`/api/webhooks/${disabledWebhookId}`)
      .send({ enabled: true })
      .expect(400);
  });

  it('lists webhooks', async () => {
    const res = await request(app).get('/api/webhooks').expect(200);
    assert.ok(Array.isArray(res.body));
    const row = res.body.find(w => w.id === webhookId);
    assert.ok(row);
    assert.equal(row.secret, '••••••••cret');
  });

  it('keeps the stored secret when a masked value is written back', async () => {
    await request(app)
      .put(`/api/webhooks/${webhookId}`)
      .send({ name: 'Renamed Webhook', secret: '••••••••cret' })
      .expect(200);

    // The real secret still validates incoming requests.
    await request(app)
      .post(`/api/webhooks/incoming/${webhookId}`)
      .set('authorization', 'Bearer test-secret')
      .send({ ping: 'masked-writeback' })
      .expect(202);
  });

  it('rejects incoming webhook if secret is missing/invalid', async () => {
    await request(app)
      .post(`/api/webhooks/incoming/${webhookId}`)
      .send({ hello: 'world' })
      .expect(401);
  });

  it('accepts incoming webhook with correct github signature', async () => {
    const payload = JSON.stringify({ action: 'opened', issue: { number: 42 } });
    const hmac = crypto.createHmac('sha256', 'test-secret');
    const signature = 'sha256=' + hmac.update(payload).digest('hex');

    const res = await request(app)
      .post(`/api/webhooks/incoming/${webhookId}`)
      .set('x-hub-signature-256', signature)
      .set('x-github-event', 'issues')
      .set('content-type', 'application/json')
      .send(payload)
      .expect(202);

    assert.equal(res.body.success, true);
  });

  it('accepts incoming webhook with basic token', async () => {
    const res = await request(app)
      .post(`/api/webhooks/incoming/${webhookId}`)
      .set('authorization', 'Bearer test-secret')
      .send({ ping: 'pong' })
      .expect(202);

    assert.equal(res.body.success, true);
  });

  it('does not accept secrets in query strings or retain credential headers', async () => {
    await request(app)
      .post(`/api/webhooks/incoming/${webhookId}?secret=test-secret`)
      .send({ unsafe: true })
      .expect(401);

    const delivery = `redaction-${Date.now()}`;
    await request(app)
      .post(`/api/webhooks/incoming/${webhookId}`)
      .set('authorization', 'Bearer test-secret')
      .set('x-api-key', 'test-secret')
      .set('cookie', 'session=secret')
      .set('x-github-delivery', delivery)
      .set('x-github-event', 'ping')
      .send({ safe: true })
      .expect(202);

    const stored = db.prepare('SELECT headers FROM webhook_events WHERE id=?').get(delivery);
    const headers = JSON.parse(stored.headers);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers['x-github-event'], 'ping');
  });

  it('accepts incoming webhook using an env secret reference', async () => {
    process.env.HIVE_TEST_WEBHOOK_SECRET = 'env-secret-value';

    const created = await request(app)
      .post('/api/webhooks')
      .send({ name: 'Env Webhook', secret: 'env:HIVE_TEST_WEBHOOK_SECRET' })
      .expect(201);

    envWebhookId = created.body.id;
    assert.equal(created.body.secret, 'env:HIVE_TEST_WEBHOOK_SECRET');

    await request(app)
      .post(`/api/webhooks/incoming/${envWebhookId}`)
      .set('x-api-key', 'env-secret-value')
      .send({ ok: true })
      .expect(202);

    await request(app)
      .post(`/api/webhooks/incoming/${envWebhookId}`)
      .set('x-api-key', 'env:HIVE_TEST_WEBHOOK_SECRET')
      .send({ ok: false })
      .expect(401);
  });

  it('uses env secret references for github signatures', async () => {
    process.env.HIVE_TEST_WEBHOOK_SECRET = 'env-signing-secret';
    const created = await request(app)
      .post('/api/webhooks')
      .send({ name: 'Env Signed Webhook', secret: 'env:HIVE_TEST_WEBHOOK_SECRET' })
      .expect(201);
    envSignedWebhookId = created.body.id;

    const payload = JSON.stringify({ action: 'signed' });
    const signature = 'sha256=' + crypto
      .createHmac('sha256', process.env.HIVE_TEST_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    await request(app)
      .post(`/api/webhooks/incoming/${envSignedWebhookId}`)
      .set('x-hub-signature-256', signature)
      .set('content-type', 'application/json')
      .send(payload)
      .expect(202);
  });

  it('fetches webhook events', async () => {
    const res = await request(app).get(`/api/webhooks/${webhookId}/events`).expect(200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 4); // github, basic token, redaction, and masked-writeback
    const ghEvent = res.body.find(e => e.event_type === 'issues');
    assert.ok(ghEvent, 'should find github event');
    assert.deepEqual(ghEvent.payload, { action: 'opened', issue: { number: 42 } });
  });

  it('clears webhook events', async () => {
    await request(app).delete(`/api/webhooks/${webhookId}/events`).expect(200);
    const res = await request(app).get(`/api/webhooks/${webhookId}/events`).expect(200);
    assert.equal(res.body.length, 0);
  });
});
