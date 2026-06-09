const { describe, it, before, after } = require('node:test');
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
    assert.equal(res.body.secret, 'test-secret');
    webhookId = res.body.id;
  });

  it('lists webhooks', async () => {
    const res = await request(app).get('/api/webhooks').expect(200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.find(w => w.id === webhookId));
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
    assert.equal(res.body.length, 2); // The github one and the basic token one
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
