// Unit tests for the colony work queue (colonies-first spec, R3).
// Covers CRUD + status transitions, run reconciliation (claimed → done when
// the run finishes, claimed → queued when the run row vanishes), and release
// semantics on team delete.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const teams = require('../lib/colonyTeams');
const workItems = require('../lib/colonyWorkItems');
const { createColony } = require('../lib/colonyRunner');

const createdTeams = [];
const createdItems = [];
const createdRuns = [];
after(() => {
  for (const id of createdItems) { try { db.prepare('DELETE FROM colony_work_items WHERE id=?').run(id); } catch {} }
  for (const id of createdRuns) { try { db.prepare('DELETE FROM colonies WHERE id=?').run(id); } catch {} }
  for (const id of createdTeams) { try { db.prepare('DELETE FROM colony_teams WHERE id=?').run(id); } catch {} }
});

function makeTeam(extra = {}) {
  const t = teams.createTeam({ name: `Queue team ${Date.now()}-${Math.round(performance.now())}`, ...extra });
  createdTeams.push(t.id);
  return t;
}

function makeItem(extra = {}) {
  const item = workItems.createWorkItem({ title: 'Fix the flaky test', ...extra });
  createdItems.push(item.id);
  return item;
}

describe('createWorkItem', () => {
  it('requires a title or direction', () => {
    assert.throws(() => workItems.createWorkItem({}), /title or a direction/i);
  });
  it('rejects unknown sources and statuses', () => {
    assert.throws(() => workItems.createWorkItem({ title: 'x', source: 'carrier-pigeon' }), /unknown source/i);
    assert.throws(() => workItems.createWorkItem({ title: 'x', status: 'lost' }), /unknown status/i);
  });
  it('round-trips the full shape, including the board card', () => {
    const team = makeTeam();
    const card = { id: 'issue-7', repo: 'acme/widget', number: 7, title: 'Widget breaks' };
    const item = makeItem({ teamId: team.id, source: 'board', sourceRef: 'issue-7', boardCard: card, status: 'proposed', matchReason: 'repo match' });
    assert.equal(item.team_id, team.id);
    assert.equal(item.status, 'proposed');
    assert.equal(item.source, 'board');
    assert.deepEqual(item.board_card, card);
    assert.equal(item.match_reason, 'repo match');
    assert.deepEqual(workItems.getWorkItem(item.id), item);
  });
  it('derives a title from the board card or direction when missing', () => {
    const fromCard = makeItem({ title: '', boardCard: { id: 'i-1', title: 'Card title' } });
    assert.equal(fromCard.title, 'Card title');
    const fromDirection = makeItem({ title: '', direction: 'Ship the login fix\nwith tests' });
    assert.equal(fromDirection.title, 'Ship the login fix');
  });
});

describe('listWorkItems / queueCountsForTeam', () => {
  it('lists open items only by default and counts depth as proposed+queued', () => {
    const team = makeTeam();
    makeItem({ teamId: team.id, status: 'proposed' });
    makeItem({ teamId: team.id, status: 'queued' });
    makeItem({ teamId: team.id, status: 'dismissed' });
    const open = workItems.listWorkItems(team.id);
    assert.equal(open.length, 2);
    const counts = workItems.queueCountsForTeam(team.id);
    assert.equal(counts.depth, 2);
    assert.equal(workItems.listWorkItems(team.id, { includeClosed: true }).length, 3);
  });
});

describe('updateWorkItem', () => {
  it('accepts a proposed item into the queue and dismisses items', () => {
    const team = makeTeam();
    const item = makeItem({ teamId: team.id, status: 'proposed' });
    assert.equal(workItems.updateWorkItem(item.id, { status: 'queued' }).status, 'queued');
    assert.equal(workItems.updateWorkItem(item.id, { status: 'dismissed' }).status, 'dismissed');
  });
  it('appends to match_reason when rerouted to a different team', () => {
    const a = makeTeam();
    const b = makeTeam();
    const item = makeItem({ teamId: a.id, matchReason: 'repo match' });
    const moved = workItems.updateWorkItem(item.id, { team_id: b.id });
    assert.equal(moved.team_id, b.id);
    assert.match(moved.match_reason, /repo match.*rerouted/);
  });
});

describe('claim + reconcile', () => {
  it('claims an item onto a run and marks it done when the run finishes', () => {
    const team = makeTeam();
    const item = makeItem({ teamId: team.id });
    const runId = createColony('Queue claim test', 'llama3', undefined, { teamId: team.id });
    createdRuns.push(runId);

    const claimed = workItems.claimWorkItem(item.id, runId, 'do it carefully');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.run_id, runId);
    assert.equal(claimed.direction, 'do it carefully');

    // Run still running → stays claimed on read.
    db.prepare("UPDATE colonies SET status='running' WHERE id=?").run(runId);
    assert.equal(workItems.listWorkItems(team.id).find(i => i.id === item.id).status, 'claimed');

    // Run finished → flips to done on the next read.
    db.prepare("UPDATE colonies SET status='done' WHERE id=?").run(runId);
    workItems.reconcileClaimedItems();
    assert.equal(workItems.getWorkItem(item.id).status, 'done');
  });

  it('returns a claimed item to queued when its run row is deleted', () => {
    const team = makeTeam();
    const item = makeItem({ teamId: team.id });
    const runId = createColony('Queue orphan test', 'llama3', undefined, { teamId: team.id });
    workItems.claimWorkItem(item.id, runId);
    db.prepare('DELETE FROM colonies WHERE id=?').run(runId);
    workItems.reconcileClaimedItems();
    const after = workItems.getWorkItem(item.id);
    assert.equal(after.status, 'queued');
    assert.equal(after.run_id, null);
  });
});

describe('release semantics', () => {
  it('deleteTeam releases open items to Unrouted and keeps done/dismissed history', () => {
    const team = makeTeam();
    const open = makeItem({ teamId: team.id, status: 'queued' });
    const doneItem = makeItem({ teamId: team.id, status: 'done' });
    teams.deleteTeam(team.id);

    const released = workItems.getWorkItem(open.id);
    assert.equal(released.team_id, null);
    assert.equal(released.status, 'queued');
    assert.ok(workItems.listUnroutedItems().some(i => i.id === open.id));
    // Done items keep their team_id — they're history, not live work.
    assert.equal(workItems.getWorkItem(doneItem.id).team_id, team.id);
  });

  it('releaseRunItems returns claimed items to queued', () => {
    const team = makeTeam();
    const item = makeItem({ teamId: team.id });
    const runId = createColony('Release run test', 'llama3', undefined, { teamId: team.id });
    createdRuns.push(runId);
    workItems.claimWorkItem(item.id, runId);
    workItems.releaseRunItems(runId);
    const after = workItems.getWorkItem(item.id);
    assert.equal(after.status, 'queued');
    assert.equal(after.run_id, null);
  });
});

describe('roster status derived from runs', () => {
  it('listTeams reports idle/working plus queue counts', () => {
    const team = makeTeam();
    makeItem({ teamId: team.id, status: 'proposed' });
    let row = teams.listTeams().find(t => t.id === team.id);
    assert.equal(row.status, 'idle');
    assert.equal(row.queue.depth, 1);
    assert.equal(row.active_run, null);

    const runId = createColony('Roster status test', 'llama3', undefined, { teamId: team.id });
    createdRuns.push(runId);
    db.prepare("UPDATE colonies SET status='running' WHERE id=?").run(runId);
    row = teams.listTeams().find(t => t.id === team.id);
    assert.equal(row.status, 'working');
    assert.equal(row.active_run.id, runId);

    db.prepare("UPDATE colonies SET status='done' WHERE id=?").run(runId);
    row = teams.listTeams().find(t => t.id === team.id);
    assert.equal(row.status, 'idle');
  });
});
