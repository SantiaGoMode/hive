// start_colony_mission (hive_admin) lets the Steward launch a real colony run
// for a named team instead of improvising with create_agent/create_pipeline.
// The discord/missions + discord/operator modules are lazily required inside the
// handler, so we mutate their cached exports to stub launch/queue/model.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const missions = require('../lib/discord/missions');
const operator = require('../lib/discord/operator');
const { start_colony_mission: tool } = require('../lib/tools/adminTools');

const TEAM_ID = `team-steward-launch-${Date.now()}`;
const orig = {};

describe('start_colony_mission (Steward colony launch)', () => {
  before(() => {
    db.prepare('INSERT INTO colony_teams (id, name, recipe_id, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())')
      .run(TEAM_ID, 'Quantum Insights', 'research_brief');
    for (const fn of ['activeRunForTeam', 'launchTeamMission', 'queueTeamWork']) orig[fn] = missions[fn];
    orig.ensureOperatorAgent = operator.ensureOperatorAgent;
    operator.ensureOperatorAgent = () => ({ model: 'test-model' });
  });
  after(() => {
    for (const fn of ['activeRunForTeam', 'launchTeamMission', 'queueTeamWork']) missions[fn] = orig[fn];
    operator.ensureOperatorAgent = orig.ensureOperatorAgent;
    db.prepare('DELETE FROM colony_teams WHERE id=?').run(TEAM_ID);
  });
  beforeEach(() => {
    missions.activeRunForTeam = () => null;
    missions.launchTeamMission = () => ({ runId: 'run-abc', item: { id: 'wi-1' } });
    missions.queueTeamWork = () => ({ item: { id: 'wi-queued' } });
    operator.ensureOperatorAgent = () => ({ model: 'test-model' });
  });

  it('launches a colony run for a team resolved by name', async () => {
    let launched = null;
    missions.launchTeamMission = (teamId, dir, opts) => { launched = { teamId, dir, opts }; return { runId: 'run-abc' }; };
    const res = await tool.handler({ team: 'quantum insights', direction: 'Develop a research artifact on 2026 AI trends' });
    assert.equal(res.success, true);
    assert.equal(res.run_id, 'run-abc');
    assert.equal(launched.teamId, TEAM_ID);
    assert.equal(launched.dir, 'Develop a research artifact on 2026 AI trends');
    assert.equal(launched.opts.model, 'test-model');
  });

  it('queues the work when the team is already running', async () => {
    missions.activeRunForTeam = () => ({ id: 'run-live' });
    let launchCalled = false;
    missions.launchTeamMission = () => { launchCalled = true; };
    const res = await tool.handler({ team: 'Quantum Insights', direction: 'another mission' });
    assert.equal(launchCalled, false);
    assert.equal(res.queued, true);
    assert.match(res.message, /queued/i);
  });

  it('errors clearly when no team matches', async () => {
    const res = await tool.handler({ team: 'Nonexistent Team', direction: 'x' });
    assert.ok(res.error);
    assert.match(res.error, /No colony team matches/);
  });

  it('errors when no operator model is available', async () => {
    operator.ensureOperatorAgent = () => null;
    const res = await tool.handler({ team: 'Quantum Insights', direction: 'x' });
    assert.match(res.error, /No Operator model/);
  });

  it('requires a direction', async () => {
    const res = await tool.handler({ team: 'Quantum Insights', direction: '  ' });
    assert.match(res.error, /direction/i);
  });
});
