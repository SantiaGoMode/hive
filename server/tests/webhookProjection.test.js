const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const db = require('../db');
const webhooksRouter = require('../routes/webhooks');
const { resolvePath, project, buildEnvelope } = require('../lib/webhookProjection');
const { executeTool } = require('../lib/agentTools');

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhooksRouter);

const GH_PUSH = {
  ref: 'refs/heads/main',
  repository: { full_name: 'acme/api', private: false },
  pusher: { name: 'cris' },
  head_commit: { message: 'fix race condition', id: 'abc' },
  commits: [{ id: 'c0', message: 'first' }, { id: 'c1', message: 'second' }],
};

describe('webhookProjection lib', () => {
  it('resolves dot-paths including array indexing', () => {
    assert.equal(resolvePath('repository.full_name', GH_PUSH), 'acme/api');
    assert.equal(resolvePath('commits.1.id', GH_PUSH), 'c1');
    assert.equal(resolvePath('pusher.name', GH_PUSH), 'cris');
  });

  it('returns undefined for missing paths', () => {
    assert.equal(resolvePath('does.not.exist', GH_PUSH), undefined);
    assert.equal(resolvePath('repository.missing.deep', GH_PUSH), undefined);
  });

  it('projects only the mapped fields', () => {
    const spec = [
      { label: 'repo', path: 'repository.full_name' },
      { label: 'author', path: 'pusher.name' },
      { label: 'message', path: 'head_commit.message' },
    ];
    const out = project(spec, GH_PUSH, 'push');
    assert.deepEqual(out, { repo: 'acme/api', author: 'cris', message: 'fix race condition' });
  });

  it('honors per-event-type mappings', () => {
    const spec = [
      { label: 'repo', path: 'repository.full_name' },              // all events
      { label: 'commit', path: 'head_commit.id', event_type: 'push' },
      { label: 'issue', path: 'issue.number', event_type: 'issues' },
    ];
    const pushOut = project(spec, GH_PUSH, 'push');
    assert.deepEqual(pushOut, { repo: 'acme/api', commit: 'abc' });
    const issuesOut = project(spec, GH_PUSH, 'issues');
    // issue.number missing in this payload -> undefined, repo still applies
    assert.deepEqual(issuesOut, { repo: 'acme/api', issue: undefined });
  });

  it('buildEnvelope falls back to full payload when no spec applies', () => {
    const env = buildEnvelope([], { id: 'e1', event_type: 'push', payload: GH_PUSH });
    assert.equal(env._projected, false);
    assert.deepEqual(env.context, GH_PUSH);
    assert.equal(env._event_id, 'e1');
  });

  it('buildEnvelope distills and carries the event handle when a spec applies', () => {
    const spec = [{ label: 'repo', path: 'repository.full_name' }];
    const env = buildEnvelope(spec, { id: 'e2', event_type: 'push', payload: GH_PUSH });
    assert.equal(env._projected, true);
    assert.deepEqual(env.context, { repo: 'acme/api' });
    assert.equal(env._event_id, 'e2');
    assert.equal(env._event_type, 'push');
  });
});

describe('projected endpoint + get_webhook_event tool', () => {
  let webhookId, eventId;

  after(() => {
    try {
      if (webhookId) {
        db.prepare('DELETE FROM webhook_events WHERE webhook_id = ?').run(webhookId);
        db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId);
      }
    } catch (e) {}
  });

  it('creates a webhook with a context spec', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({
        name: 'Projection Test',
        context_spec: [
          { label: 'repo', path: 'repository.full_name' },
          { label: 'author', path: 'pusher.name' },
        ],
      })
      .expect(201);
    webhookId = res.body.id;
    const spec = JSON.parse(res.body.context_spec);
    assert.equal(spec.length, 2);
  });

  it('stores a raw event then returns a distilled envelope', async () => {
    await request(app)
      .post(`/api/webhooks/incoming/${webhookId}`)
      .set('x-github-event', 'push')
      .send(GH_PUSH)
      .expect(202);

    const events = await request(app).get(`/api/webhooks/${webhookId}/events`).expect(200);
    eventId = events.body[0].id;

    const res = await request(app)
      .get(`/api/webhooks/${webhookId}/events/${eventId}/projected`)
      .expect(200);

    assert.equal(res.body._projected, true);
    assert.deepEqual(res.body.context, { repo: 'acme/api', author: 'cris' });
    assert.equal(res.body._event_id, eventId);
    // Distilled context is far smaller than the full payload.
    assert.ok(Object.keys(res.body.context).length < Object.keys(GH_PUSH).length);
  });

  it('get_webhook_event tool returns the full raw payload by id', async () => {
    const out = await executeTool('get_webhook_event', { event_id: eventId });
    assert.equal(out.event_type, 'push');
    assert.deepEqual(out.payload, GH_PUSH);
    assert.equal(out.headers, undefined); // not requested
  });

  it('get_webhook_event includes headers when asked', async () => {
    const out = await executeTool('get_webhook_event', { event_id: eventId, include_headers: true });
    assert.ok(out.headers && typeof out.headers === 'object');
  });

  it('get_webhook_event returns an error for a missing id', async () => {
    const out = await executeTool('get_webhook_event', { event_id: 'nope-does-not-exist' });
    assert.ok(out.error);
  });
});
