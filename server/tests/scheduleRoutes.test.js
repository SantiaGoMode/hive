// HTTP tests for /api/schedules (issue #47). scheduler.register/unregister/
// runSchedule are stubbed (save/restore) so no node-cron tasks or background
// agent runs are created.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../db');
const scheduler = require('../lib/scheduler');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/schedules'), '/api/schedules');
const created = [];
const createdPipelines = [];
const orig = {};

before(() => {
  for (const fn of ['register', 'unregister', 'runSchedule']) { orig[fn] = scheduler[fn]; scheduler[fn] = () => {}; }
});
after(() => {
  for (const fn of Object.keys(orig)) scheduler[fn] = orig[fn];
  for (const id of created) { try { db.prepare('DELETE FROM scheduled_runs WHERE id=?').run(id); } catch {} }
  for (const id of createdPipelines) { try { db.prepare('DELETE FROM pipelines WHERE id=?').run(id); } catch {} }
});

const validBody = (extra = {}) => ({ agent_id: 'a1', label: 'Nightly', cron_expr: '0 8 * * *', prompt: 'go', ...extra });

function makePipeline(id = `pl-sched-test-${Date.now()}-${createdPipelines.length}`) {
  db.prepare('INSERT OR REPLACE INTO pipelines (id, name, steps) VALUES (?, ?, ?)').run(id, 'Sched Pipeline', '[]');
  createdPipelines.push(id);
  return id;
}

describe('Schedules API', () => {
  it('lists schedules', async () => {
    const res = await request(app).get('/api/schedules').expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it('rejects create with a missing required field', async () => {
    await request(app).post('/api/schedules').send({ label: 'x' }).expect(400);
  });

  it('rejects create with an invalid cron expression', async () => {
    const res = await request(app).post('/api/schedules').send(validBody({ cron_expr: 'not a cron' })).expect(400);
    assert.match(res.body.error, /cron/i);
  });

  it('creates a schedule (and registers it)', async () => {
    let registered = false;
    scheduler.register = () => { registered = true; };
    const res = await request(app).post('/api/schedules').send(validBody()).expect(201);
    created.push(res.body.id);
    assert.equal(res.body.label, 'Nightly');
    assert.ok(registered);
  });

  it('toggles a schedule enabled flag', async () => {
    const made = await request(app).post('/api/schedules').send(validBody({ enabled: true })).expect(201);
    created.push(made.body.id);
    const res = await request(app).post(`/api/schedules/${made.body.id}/toggle`).expect(200);
    assert.equal(!!res.body.enabled, false);
  });

  it('404s a missing schedule and deletes an existing one', async () => {
    await request(app).get('/api/schedules/missing').expect(404);
    const made = await request(app).post('/api/schedules').send(validBody()).expect(201);
    await request(app).delete(`/api/schedules/${made.body.id}`).expect(200);
  });

  it('creates a pipeline-target schedule and rejects unknown pipelines', async () => {
    const pipelineId = makePipeline();

    // Missing both targets is a 400; unknown pipeline is a 400.
    const noTarget = await request(app).post('/api/schedules')
      .send({ label: 'x', cron_expr: '0 8 * * *', prompt: 'go' }).expect(400);
    assert.match(noTarget.body.error, /agent_id, pipeline_id, or team_id/);
    await request(app).post('/api/schedules')
      .send({ pipeline_id: 'nope', label: 'x', cron_expr: '0 8 * * *', prompt: 'go' }).expect(400);

    const made = await request(app).post('/api/schedules')
      .send({ pipeline_id: pipelineId, label: 'Pipeline nightly', cron_expr: '0 8 * * *', prompt: 'go' })
      .expect(201);
    created.push(made.body.id);
    assert.equal(made.body.pipeline_id, pipelineId);
    assert.equal(made.body.agent_id, '');

    const fetched = await request(app).get(`/api/schedules/${made.body.id}`).expect(200);
    assert.equal(fetched.body.pipeline_id, pipelineId);
    assert.equal(fetched.body.agent_id, '');

    // Switching back to an agent target clears pipeline_id.
    const updated = await request(app).put(`/api/schedules/${made.body.id}`)
      .send({ agent_id: 'a1', pipeline_id: '' }).expect(200);
    assert.equal(updated.body.pipeline_id, null);
    assert.equal(updated.body.agent_id, 'a1');
  });

  it('normalizes target switches when update payloads include only the new target', async () => {
    const pipelineId = makePipeline();
    const made = await request(app).post('/api/schedules').send(validBody({ agent_id: 'agent-old' })).expect(201);
    created.push(made.body.id);

    const asPipeline = await request(app).put(`/api/schedules/${made.body.id}`)
      .send({ pipeline_id: pipelineId })
      .expect(200);
    assert.equal(asPipeline.body.pipeline_id, pipelineId);
    assert.equal(asPipeline.body.agent_id, '');

    const storedPipeline = db.prepare('SELECT agent_id, pipeline_id FROM scheduled_runs WHERE id=?').get(made.body.id);
    assert.deepEqual(storedPipeline, { agent_id: '', pipeline_id: pipelineId });

    const asAgent = await request(app).put(`/api/schedules/${made.body.id}`)
      .send({ agent_id: 'agent-new' })
      .expect(200);
    assert.equal(asAgent.body.pipeline_id, null);
    assert.equal(asAgent.body.agent_id, 'agent-new');

    const noTarget = await request(app).put(`/api/schedules/${made.body.id}`)
      .send({ agent_id: '' })
      .expect(400);
    assert.match(noTarget.body.error, /agent_id, pipeline_id, or team_id/);
  });

  it('creates a colony-team schedule and rejects unknown teams', async () => {
    const teamId = `team-sched-${Date.now()}`;
    db.prepare('INSERT INTO colony_teams (id, name, recipe_id, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())')
      .run(teamId, 'Sched Team', 'research_brief');

    await request(app).post('/api/schedules')
      .send({ team_id: 'nope', label: 'x', cron_expr: '0 9 * * 1', prompt: 'weekly digest' }).expect(400);

    const made = await request(app).post('/api/schedules')
      .send({ team_id: teamId, label: 'Weekly digest', cron_expr: '0 9 * * 1', prompt: 'weekly digest' })
      .expect(201);
    created.push(made.body.id);
    assert.equal(made.body.team_id, teamId);
    assert.equal(made.body.agent_id, '');
    assert.equal(made.body.pipeline_id, null);

    // Switching to an agent target clears team_id.
    const updated = await request(app).put(`/api/schedules/${made.body.id}`)
      .send({ agent_id: 'a1' }).expect(200);
    assert.equal(updated.body.team_id, null);
    assert.equal(updated.body.agent_id, 'a1');

    db.prepare('DELETE FROM colony_teams WHERE id=?').run(teamId);
  });
});
