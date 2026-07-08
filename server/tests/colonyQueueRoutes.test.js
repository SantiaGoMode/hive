// Route tests for the colony work queue (colonies-first spec, R3).
// The start endpoint is validated up to (but not including) an actual launch —
// launching spins agents/models, which unit tests must not do.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const db = require('../db');
const teams = require('../lib/colonyTeams');
const workItems = require('../lib/colonyWorkItems');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/colony', require('../routes/colony'));
  return app;
}

const app = buildApp();
const createdTeams = [];
const createdItems = [];

after(() => {
  for (const id of createdItems) { try { db.prepare('DELETE FROM colony_work_items WHERE id=?').run(id); } catch {} }
  for (const id of createdTeams) { try { db.prepare('DELETE FROM colony_teams WHERE id=?').run(id); } catch {} }
});

function makeTeam(extra = {}) {
  const t = teams.createTeam({ name: `Queue routes ${Date.now()}-${Math.round(performance.now())}`, ...extra });
  createdTeams.push(t.id);
  return t;
}

describe('team queue CRUD', () => {
  it('404s for an unknown team', async () => {
    const res = await request(app).get('/api/colony/teams/no-such-team/queue');
    assert.equal(res.status, 404);
  });

  it('adds a free-form item as queued and lists it', async () => {
    const team = makeTeam();
    const post = await request(app)
      .post(`/api/colony/teams/${team.id}/queue`)
      .send({ title: 'Investigate slow boot', direction: 'Profile server startup' });
    assert.equal(post.status, 200);
    createdItems.push(post.body.id);
    assert.equal(post.body.status, 'queued');
    assert.equal(post.body.source, 'manual');

    const list = await request(app).get(`/api/colony/teams/${team.id}/queue`);
    assert.equal(list.status, 200);
    assert.ok(list.body.some(i => i.id === post.body.id));
  });

  it('adds a board card item with source board and a derived title', async () => {
    const team = makeTeam();
    const card = { id: 'issue-9', repo: 'acme/x', number: 9, title: 'Board card title' };
    const post = await request(app)
      .post(`/api/colony/teams/${team.id}/queue`)
      .send({ board_card: card });
    assert.equal(post.status, 200);
    createdItems.push(post.body.id);
    assert.equal(post.body.source, 'board');
    assert.equal(post.body.title, 'Board card title');
    assert.deepEqual(post.body.board_card, card);
  });

  it('rejects an empty item', async () => {
    const team = makeTeam();
    const post = await request(app).post(`/api/colony/teams/${team.id}/queue`).send({});
    assert.equal(post.status, 400);
  });

  it('accepts, dismisses, reroutes, and deletes items', async () => {
    const a = makeTeam();
    const b = makeTeam();
    const item = workItems.createWorkItem({ teamId: a.id, title: 'Proposed thing', status: 'proposed' });
    createdItems.push(item.id);

    const accept = await request(app).put(`/api/colony/teams/${a.id}/queue/${item.id}`).send({ status: 'queued' });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.status, 'queued');

    const claim = await request(app).put(`/api/colony/teams/${a.id}/queue/${item.id}`).send({ status: 'claimed' });
    assert.equal(claim.status, 400); // claiming happens via the start endpoint only

    const badTeam = await request(app).put(`/api/colony/teams/${a.id}/queue/${item.id}`).send({ team_id: 'nope' });
    assert.equal(badTeam.status, 400);

    const reroute = await request(app).put(`/api/colony/teams/${a.id}/queue/${item.id}`).send({ team_id: b.id });
    assert.equal(reroute.status, 200);
    assert.equal(reroute.body.team_id, b.id);

    // The item now belongs to b — a's routes no longer see it.
    const gone = await request(app).put(`/api/colony/teams/${a.id}/queue/${item.id}`).send({ status: 'dismissed' });
    assert.equal(gone.status, 404);

    const del = await request(app).delete(`/api/colony/teams/${b.id}/queue/${item.id}`);
    assert.equal(del.status, 200);
    assert.equal(workItems.getWorkItem(item.id), null);
  });
});

describe('POST .../queue/:itemId/start validation', () => {
  it('404s for unknown team or item', async () => {
    const team = makeTeam();
    const res = await request(app).post(`/api/colony/teams/${team.id}/queue/no-such-item/start`).send({ model: 'llama3' });
    assert.equal(res.status, 404);
  });

  it('requires a model', async () => {
    const team = makeTeam();
    const item = workItems.createWorkItem({ teamId: team.id, title: 'Needs model', status: 'queued' });
    createdItems.push(item.id);
    const res = await request(app).post(`/api/colony/teams/${team.id}/queue/${item.id}/start`).send({});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /model is required/);
  });

  it('rejects items that are not proposed/queued', async () => {
    const team = makeTeam();
    const item = workItems.createWorkItem({ teamId: team.id, title: 'Already done', status: 'done' });
    createdItems.push(item.id);
    const res = await request(app).post(`/api/colony/teams/${team.id}/queue/${item.id}/start`).send({ model: 'llama3' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /done/);
  });

  it('rejects a cloud model plan when the team is local-only', async () => {
    const team = makeTeam(); // cloudEnabled defaults to false
    const item = workItems.createWorkItem({ teamId: team.id, title: 'Cloud gated', status: 'queued' });
    createdItems.push(item.id);
    const res = await request(app)
      .post(`/api/colony/teams/${team.id}/queue/${item.id}/start`)
      .send({ model: 'anthropic/claude-sonnet-5', model_plan: { operator: 'anthropic/claude-sonnet-5' } });
    assert.equal(res.status, 400);
  });
});

describe('unrouted tray', () => {
  it('lists unrouted items and routes them to a team', async () => {
    const team = makeTeam();
    const item = workItems.createWorkItem({ title: 'Homeless work', status: 'proposed' });
    createdItems.push(item.id);

    const tray = await request(app).get('/api/colony/queue/unrouted');
    assert.equal(tray.status, 200);
    assert.ok(tray.body.some(i => i.id === item.id));

    const route = await request(app).put(`/api/colony/queue/${item.id}`).send({ team_id: team.id, status: 'queued' });
    assert.equal(route.status, 200);
    assert.equal(route.body.team_id, team.id);

    const trayAfter = await request(app).get('/api/colony/queue/unrouted');
    assert.ok(!trayAfter.body.some(i => i.id === item.id));
  });
});
