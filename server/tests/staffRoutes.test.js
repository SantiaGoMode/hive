// HTTP tests for /api/staff (issue #47). staffScheduler.generateMentionResponses
// is stubbed so POST /chat doesn't trigger a real background generation.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../db');
const staffScheduler = require('../lib/staffScheduler');
const { deleteAgent } = require('../lib/agentParser');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/staff'), '/api/staff');
const createdProfiles = [];
const createdAgents = [];
let origMentions;

before(() => { origMentions = staffScheduler.generateMentionResponses; staffScheduler.generateMentionResponses = async () => []; });
after(() => {
  staffScheduler.generateMentionResponses = origMentions;
  for (const id of createdAgents) { try { deleteAgent(id); } catch {} }
  for (const id of createdProfiles) { try { db.prepare('DELETE FROM staff_profiles WHERE id=?').run(id); } catch {} }
  try { db.prepare("DELETE FROM staff_chat_messages WHERE content LIKE 'route-test:%'").run(); } catch {}
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

  it('lists chat messages and rejects an empty post', async () => {
    await request(app).get('/api/staff/chat').expect(200);
    await request(app).post('/api/staff/chat').send({}).expect(400);
  });

  it('posts a chat message (mention generation stubbed)', async () => {
    const res = await request(app).post('/api/staff/chat').send({ content: 'route-test: hello team' }).expect(201);
    assert.ok(res.body.message);
    assert.equal(res.body.message.content, 'route-test: hello team');
  });

  it('clears chat messages', async () => {
    await request(app).delete('/api/staff/chat').expect(200);
    const res = await request(app).get('/api/staff/chat').expect(200);
    assert.equal(res.body.messages.length, 0);
  });
});
