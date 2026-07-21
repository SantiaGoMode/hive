// Unit tests for colonyTeams CRUD (issue #46). Uses the temp test DB; cleans up
// created teams. Covers validation, round-trip shape, update, and delete.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const teams = require('../lib/colonyTeams');

const created = [];
after(() => { for (const id of created) { try { db.prepare('DELETE FROM colony_teams WHERE id=?').run(id); } catch {} } });

function make(extra = {}) {
  const t = teams.createTeam({ name: `Team ${Date.now()}-${Math.round(performance.now())}`, ...extra });
  created.push(t.id);
  return t;
}

describe('createTeam', () => {
  it('requires a name', () => {
    assert.throws(() => teams.createTeam({ name: '   ' }), /name is required/i);
  });
  it('rejects an unknown recipe', () => {
    assert.throws(() => teams.createTeam({ name: 'X', recipeId: 'no-such-recipe' }), /unknown recipe_id/i);
  });
  it('creates a team with the normalized boolean/default shape', () => {
    const t = make({ description: ' hi ', cloudEnabled: true });
    assert.equal(t.description, 'hi');         // trimmed
    assert.equal(t.cloud_enabled, true);       // coerced from 1
    assert.equal(t.github_writeback, false);   // default
    assert.equal(t.github_review, false);
    assert.equal(t.github_publish, false);
    assert.ok(t.recipe_id);
    assert.ok(t.id && t.created_at);
  });
});

describe('getTeam / listTeams', () => {
  it('round-trips a team and returns null for a missing id', () => {
    const t = make();
    assert.deepEqual(teams.getTeam(t.id), t);
    assert.equal(teams.getTeam('missing-team-id'), null);
  });
  it('lists teams with stats and last_run', () => {
    const t = make();
    const found = teams.listTeams().find(x => x.id === t.id);
    assert.ok(found);
    assert.equal(found.stats.total_runs, 0);   // no runs yet
    assert.equal(found.last_run, null);
  });
});

describe('updateTeam', () => {
  it('returns null for a missing team', () => {
    assert.equal(teams.updateTeam('missing', { name: 'x' }), null);
  });
  it('rejects clearing the name', () => {
    const t = make();
    assert.throws(() => teams.updateTeam(t.id, { name: '  ' }), /name is required/i);
  });
  it('patches provided fields only', () => {
    const t = make();
    const upd = teams.updateTeam(t.id, { description: 'new desc', github_writeback: true });
    assert.equal(upd.description, 'new desc');
    assert.equal(upd.github_writeback, true);
    assert.equal(upd.name, t.name); // untouched
  });
  it('separates PR review permission from repository publishing', () => {
    const review = make({ recipeId: 'code_review', githubReview: true, githubPublish: true });
    assert.equal(review.github_review, true);
    assert.equal(review.github_publish, false, 'read-only review recipes cannot publish');
    const delivery = make({ recipeId: 'development_team', githubReview: true, githubPublish: true });
    assert.equal(delivery.github_review, false, 'delivery recipe does not request GitHub review capability');
    assert.equal(delivery.github_publish, true);
  });
});

describe('deleteTeam', () => {
  it('removes the team', () => {
    const t = teams.createTeam({ name: `Del ${Date.now()}` });
    teams.deleteTeam(t.id);
    assert.equal(teams.getTeam(t.id), null);
  });
});

describe('teamOverview', () => {
  it('returns null for a missing team and a shaped overview for a real one', () => {
    assert.equal(teams.teamOverview('missing'), null);
    const t = make();
    const ov = teams.teamOverview(t.id);
    assert.equal(ov.team.id, t.id);
    assert.ok(Array.isArray(ov.runs));
  });
});
