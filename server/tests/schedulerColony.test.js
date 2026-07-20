// scheduler.runSchedule colony-team branch (issue: colony schedules). The
// discord/missions + discord/operator modules are lazily required inside the
// branch, so we mutate their cached exports to stub launch/queue/model without
// spinning up a real colony run.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const scheduler = require('../lib/scheduler');
const missions = require('../lib/discord/missions');
const operator = require('../lib/discord/operator');

const TEAM_ID = `team-sched-run-${Date.now()}`;
const SCH_ID = `sch-run-test-${Date.now()}`;
const orig = {};

function makeRow(extra = {}) {
  return { id: SCH_ID, agent_id: '', pipeline_id: null, team_id: TEAM_ID, label: 'Daily digest', cron_expr: '0 9 * * *', prompt: 'run the daily digest', enabled: 1, tools: '[]', ...extra };
}
function insertRow(extra = {}) {
  db.prepare('INSERT OR REPLACE INTO scheduled_runs (id, agent_id, pipeline_id, team_id, label, cron_expr, prompt, enabled, tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(SCH_ID, '', null, TEAM_ID, 'Daily digest', '0 9 * * *', 'run the daily digest', 1, '[]');
  return makeRow(extra);
}
function readRow() {
  return db.prepare('SELECT last_output, last_error, run_count FROM scheduled_runs WHERE id=?').get(SCH_ID);
}

describe('scheduler colony-team branch', () => {
  before(() => {
    for (const fn of ['activeRunForTeam', 'launchTeamMission', 'queueTeamWork']) orig[fn] = missions[fn];
    orig.ensureOperatorAgent = operator.ensureOperatorAgent;
    operator.ensureOperatorAgent = () => ({ model: 'test-model' });
  });
  after(() => {
    for (const fn of ['activeRunForTeam', 'launchTeamMission', 'queueTeamWork']) missions[fn] = orig[fn];
    operator.ensureOperatorAgent = orig.ensureOperatorAgent;
    db.prepare('DELETE FROM scheduled_runs WHERE id=?').run(SCH_ID);
  });
  beforeEach(() => { insertRow(); });

  it('launches a mission when the team is idle', () => {
    let launched = null;
    missions.activeRunForTeam = () => null;
    missions.launchTeamMission = (teamId, prompt, opts) => { launched = { teamId, prompt, opts }; return { runId: 'run-xyz', item: { id: 'wi-1' } }; };
    scheduler.runSchedule(makeRow());
    assert.equal(launched.teamId, TEAM_ID);
    assert.equal(launched.prompt, 'run the daily digest');
    assert.equal(launched.opts.model, 'test-model');
    assert.equal(launched.opts.source, 'schedule');
    const row = readRow();
    assert.match(row.last_output, /run-xyz/);
    assert.equal(row.last_error, null);
    assert.equal(row.run_count, 1);
  });

  it('queues work when the team is already running', () => {
    missions.activeRunForTeam = () => ({ id: 'run-live' });
    let launchCalled = false;
    missions.launchTeamMission = () => { launchCalled = true; };
    missions.queueTeamWork = () => ({ item: { id: 'wi-queued' } });
    scheduler.runSchedule(makeRow());
    assert.equal(launchCalled, false);
    const row = readRow();
    assert.match(row.last_output, /queued work item wi-queued/);
    assert.equal(row.last_error, null);
  });

  it('records an error when no operator model is available', () => {
    operator.ensureOperatorAgent = () => null;
    missions.activeRunForTeam = () => null;
    scheduler.runSchedule(makeRow());
    const row = readRow();
    assert.match(row.last_error, /No Operator model/);
    // restore for subsequent tests
    operator.ensureOperatorAgent = () => ({ model: 'test-model' });
  });

  it('records the error message when launch throws', () => {
    missions.activeRunForTeam = () => null;
    missions.launchTeamMission = () => { throw new Error('gate refused the model'); };
    scheduler.runSchedule(makeRow());
    const row = readRow();
    assert.match(row.last_error, /gate refused the model/);
  });
});
