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
const orig = {};

before(() => {
  for (const fn of ['register', 'unregister', 'runSchedule']) { orig[fn] = scheduler[fn]; scheduler[fn] = () => {}; }
});
after(() => {
  for (const fn of Object.keys(orig)) scheduler[fn] = orig[fn];
  for (const id of created) { try { db.prepare('DELETE FROM scheduled_runs WHERE id=?').run(id); } catch {} }
});

const validBody = (extra = {}) => ({ agent_id: 'a1', label: 'Nightly', cron_expr: '0 8 * * *', prompt: 'go', ...extra });

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
});
