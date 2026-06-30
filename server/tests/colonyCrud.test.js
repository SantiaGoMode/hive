const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createColony, listColonies, getColony, deleteColony } = require('../lib/colonyRunner');
const db = require('../db');

// Track IDs created in this test run so we can clean up regardless of outcome
const created = [];

function cleanup() {
  for (const id of created) {
    try { db.prepare('DELETE FROM colonies WHERE id=?').run(id); } catch {}
  }
  created.length = 0;
}

after(cleanup);

describe('createColony', () => {
  it('inserts a row and returns a non-empty string ID', () => {
    const id = createColony('Test goal A', 'llama3');
    created.push(id);
    assert.ok(typeof id === 'string' && id.length > 0, 'ID should be a non-empty string');
  });

  it('returns unique IDs for separate calls', () => {
    const id1 = createColony('Goal 1', 'llama3');
    const id2 = createColony('Goal 2', 'llama3');
    created.push(id1, id2);
    assert.notEqual(id1, id2);
  });

  it('stores the goal and model correctly', () => {
    const id = createColony('Store check goal', 'mistral');
    created.push(id);
    const row = db.prepare('SELECT goal, model, status, recipe_id FROM colonies WHERE id=?').get(id);
    assert.equal(row.goal, 'Store check goal');
    assert.equal(row.model, 'mistral');
    assert.equal(row.status, 'running'); // default
    assert.equal(row.recipe_id, 'development_team'); // post-redesign default
  });

  it('stores an explicit recipe id', () => {
    const id = createColony('Recipe check goal', 'mistral', 'research_brief');
    created.push(id);
    const row = db.prepare('SELECT recipe_id FROM colonies WHERE id=?').get(id);
    assert.equal(row.recipe_id, 'research_brief');
  });
});

describe('listColonies', () => {
  it('returns an array', () => {
    const list = listColonies();
    assert.ok(Array.isArray(list));
  });

  it('includes newly created colonies', () => {
    const id = createColony('List test goal', 'llama3');
    created.push(id);
    const list = listColonies();
    const found = list.find(c => c.id === id);
    assert.ok(found, 'New colony should appear in list');
    assert.equal(found.goal, 'List test goal');
    assert.equal(found.recipe_id, 'development_team');
  });

  it('returns agent_ids as an array (not a raw JSON string)', () => {
    const id = createColony('Agent ids check', 'llama3');
    created.push(id);
    const list = listColonies();
    const found = list.find(c => c.id === id);
    assert.ok(Array.isArray(found.agent_ids), 'agent_ids should be a parsed array');
  });

  it('orders newest first', () => {
    const id1 = createColony('Older colony', 'llama3');
    created.push(id1);
    // Force a slightly later timestamp by manually bumping created_at
    const id2 = createColony('Newer colony', 'llama3');
    created.push(id2);
    db.prepare('UPDATE colonies SET created_at = created_at + 1 WHERE id=?').run(id2);
    const list = listColonies();
    const idx1 = list.findIndex(c => c.id === id1);
    const idx2 = list.findIndex(c => c.id === id2);
    assert.ok(idx2 < idx1, 'Newer colony should appear before older colony');
  });
});

describe('getColony', () => {
  it('returns null for a non-existent ID', () => {
    const result = getColony('definitely-does-not-exist-xyz');
    assert.equal(result, null);
  });

  it('returns the full colony object for a valid ID', () => {
    const id = createColony('Get colony test', 'llama3');
    created.push(id);
    const colony = getColony(id);
    assert.ok(colony, 'Should return a colony object');
    assert.equal(colony.id, id);
    assert.equal(colony.goal, 'Get colony test');
  });

  it('returns log as a parsed array (not raw JSON)', () => {
    const id = createColony('Log parse test', 'llama3');
    created.push(id);
    const colony = getColony(id);
    assert.ok(Array.isArray(colony.log), 'log should be a parsed array');
  });

  it('returns agent_ids as a parsed array', () => {
    const id = createColony('agent_ids parse test', 'llama3');
    created.push(id);
    const colony = getColony(id);
    assert.ok(Array.isArray(colony.agent_ids), 'agent_ids should be a parsed array');
  });

  it('returns agents array (filtered from agent_ids)', () => {
    const id = createColony('Agents array test', 'llama3');
    created.push(id);
    const colony = getColony(id);
    assert.ok(Array.isArray(colony.agents), 'agents should be an array');
  });

  it('reflects summary after update', () => {
    const id = createColony('Summary test', 'llama3');
    created.push(id);
    db.prepare('UPDATE colonies SET summary=? WHERE id=?').run('Built a REST API', id);
    const colony = getColony(id);
    assert.equal(colony.summary, 'Built a REST API');
  });
});

describe('deleteColony', () => {
  it('removes the colony from the DB', () => {
    const id = createColony('To be deleted', 'llama3');
    deleteColony(id);
    const result = getColony(id);
    assert.equal(result, null, 'Colony should be gone after deleteColony');
  });

  it('is a no-op for a non-existent ID (does not throw)', () => {
    assert.doesNotThrow(() => deleteColony('ghost-id-xyz'));
  });

  it('does not affect other colonies', () => {
    const id1 = createColony('Keep me', 'llama3');
    created.push(id1);
    const id2 = createColony('Delete me', 'llama3');
    deleteColony(id2);
    const kept = getColony(id1);
    assert.ok(kept, 'Undeleted colony should still exist');
    assert.equal(getColony(id2), null, 'Deleted colony should be gone');
  });
});
