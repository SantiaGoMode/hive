// HTTP tests for /api/staff (issue #47).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../db');
const { deleteAgent } = require('../lib/agentParser');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/staff'), '/api/staff');
const createdProfiles = [];
const createdAgents = [];

after(() => {
  for (const id of createdAgents) { try { deleteAgent(id); } catch {} }
  for (const id of createdProfiles) { try { db.prepare('DELETE FROM staff_profiles WHERE id=?').run(id); } catch {} }
});

describe('Staff API', () => {
  it('lists profiles with metrics', async () => {
    const res = await request(app).get('/api/staff/profiles').expect(200);
    assert.ok(Array.isArray(res.body.profiles));
  });

  it('rejects creating a profile with no display_name/role', async () => {
    await request(app).post('/api/staff/profiles').send({}).expect(400);
  });

  it('creates a custom profile', async () => {
    const res = await request(app).post('/api/staff/profiles').send({ display_name: `Tester ${Date.now()}`, role: 'QA' }).expect(201);
    createdProfiles.push(res.body.id);
    assert.equal(res.body.role, 'QA');
  });

  it('creates an agent from an existing staff profile', async () => {
    const profileRes = await request(app)
      .post('/api/staff/profiles')
      .send({
        display_name: `Agent Tester ${Date.now()}`,
        role: 'Research Analyst',
        system_prompt: 'Route-created staff prompt.',
        tools: ['web_search'],
      })
      .expect(201);
    createdProfiles.push(profileRes.body.id);

    const res = await request(app)
      .post(`/api/staff/profiles/${profileRes.body.id}/agent`)
      .send({})
      .expect(201);
    createdAgents.push(res.body.agent.id);

    assert.equal(res.body.created, true);
    assert.equal(res.body.agent.name, profileRes.body.display_name);
    assert.equal(res.body.agent.ephemeral, false);
    assert.deepEqual(res.body.agent.tools, ['web_search']);
    assert.match(res.body.agent.system_prompt, /Route-created staff prompt/);
    assert.equal(res.body.profile.assigned_agent_id, res.body.agent.id);
  });

  it('404s a missing profile', async () => {
    await request(app).get('/api/staff/profiles/no-such-profile').expect(404);
  });

  it('no longer serves the removed staff chat endpoints', async () => {
    await request(app).get('/api/staff/chat').expect(404);
    await request(app).post('/api/staff/chat').send({ content: 'hi' }).expect(404);
  });
});
