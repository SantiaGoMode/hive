const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { appendRunEvent, listRunEvents, lastSequence } = require('../lib/colony/runEvents');
const workflow = require('../lib/colony/workflow');
const { getColonyRecipe } = require('../lib/colonyRecipes');
const { runCapabilitySnapshot, defaultContextBudget } = require('../lib/colonyPolicy');
const outbox = require('../lib/colonyOutbox');

const runId = `durable-test-${Date.now()}`;
before(() => {
  db.prepare('INSERT INTO colonies (id, goal, model, status) VALUES (?, ?, ?, ?)')
    .run(runId, 'Durability ownership test', 'test-model', 'running');
});
after(() => {
  try { db.prepare('DELETE FROM colonies WHERE id=?').run(runId); } catch {}
});

describe('durable colony primitives', () => {
  it('appends replayable, monotonic run events', () => {
    assert.equal(appendRunEvent(runId, 'log_entry', { seq: 1, message: 'first' }), 1);
    assert.equal(appendRunEvent(runId, 'log_entry', { seq: 2, message: 'second' }), 2);
    assert.equal(lastSequence(runId), 2);
    assert.deepEqual(listRunEvents(runId, { since: 1 }).map(e => e.payload.message), ['second']);
  });

  it('owns dependency checks and evidence separately from model text', () => {
    workflow.syncPlan(runId, [
      { id: 'scope', description: 'Scope the work', status: 'pending' },
      { id: 'build', description: 'Build the work', status: 'pending', depends_on: ['scope'] },
    ]);
    assert.equal(workflow.transition(runId, 'build', 'in_progress').ok, false);
    assert.equal(workflow.transition(runId, 'scope', 'done').ok, true);
    assert.equal(workflow.transition(runId, 'build', 'in_progress').ok, true);
    workflow.addEvidence(runId, { nodeId: 'build', kind: 'test', payload: { command: 'npm test', exit_code: 0 }, verified: true });
    assert.equal(workflow.transition(runId, 'build', 'done').ok, true);
    assert.equal(workflow.evaluate(runId).outcome, 'complete');
  });

  it('clamps a run capability snapshot to its recipe policy', () => {
    const review = runCapabilitySnapshot(getColonyRecipe('code_review'), {
      repoPath: '/tmp/repo', githubReview: true, githubPublish: true,
    });
    assert.equal(review.repo_write, false);
    assert.equal(review.github_publish, false);
    assert.equal(review.github_review, true);
    assert.ok(defaultContextBudget(getColonyRecipe('development_team')).worker_history_chars > 0);
  });

  it('backs off failed external effects and eventually dead-letters them', async () => {
    outbox.enqueue(runId, 'unknown_test_action', `${runId}:unknown`, {});
    for (let attempt = 0; attempt < outbox.MAX_ATTEMPTS; attempt++) {
      await outbox.processRun(runId);
      db.prepare('UPDATE colony_outbox SET next_attempt_at=0 WHERE run_id=?').run(runId);
    }
    const row = db.prepare('SELECT * FROM colony_outbox WHERE run_id=?').get(runId);
    assert.equal(row.status, 'dead_letter');
    assert.equal(row.attempt_count, outbox.MAX_ATTEMPTS);
  });
});
