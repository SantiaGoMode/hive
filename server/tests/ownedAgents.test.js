// Pruning of dedicated (ephemeral) pipeline/schedule-owned agents on owner
// delete — without touching user agents, staff agents, or agents still
// referenced elsewhere.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { writeAgent, readAgent } = require('../lib/agentParser');
const { isOrphanEphemeralAgent, pruneOwnedAgents, pipelineStepAgentIds } = require('../lib/ownedAgents');

const made = { agents: [], pipelines: [], schedules: [], staff: [] };
function agent(name, ephemeral) { const a = writeAgent(null, { name, model: 'm', ephemeral }); made.agents.push(a.id); return a.id; }
function pipeline(id, agentIds) {
  db.prepare('INSERT INTO pipelines (id, name, steps) VALUES (?, ?, ?)')
    .run(id, id, JSON.stringify(agentIds.map(a => ({ agent_id: a, label: 'x', prompt: '{input}' }))));
  made.pipelines.push(id);
}

describe('ownedAgents pruning', () => {
  after(() => {
    for (const id of made.pipelines) try { db.prepare('DELETE FROM pipelines WHERE id=?').run(id); } catch {}
    for (const id of made.schedules) try { db.prepare('DELETE FROM scheduled_runs WHERE id=?').run(id); } catch {}
    for (const id of made.staff) try { db.prepare('DELETE FROM staff_profiles WHERE id=?').run(id); } catch {}
    for (const id of made.agents) try { db.prepare('DELETE FROM agents WHERE id=?').run(id); } catch {}
  });

  it('pipelineStepAgentIds parses step agent ids', () => {
    assert.deepEqual(pipelineStepAgentIds('[{"agent_id":"a1"},{"agent_id":"a2"},{"label":"no agent"}]'), ['a1', 'a2']);
    assert.deepEqual(pipelineStepAgentIds('garbage'), []);
  });

  it('only ephemeral, unreferenced agents are orphan-eligible', () => {
    const eph = agent('Ephemeral Step', 1);
    const user = agent('User Agent', 0);
    const p = `pipe-own-${Date.now()}`;
    pipeline(p, [eph, user]);
    // While the pipeline references them, neither is deletable.
    assert.equal(isOrphanEphemeralAgent(eph), false, 'referenced by pipeline → keep');
    assert.equal(isOrphanEphemeralAgent(user), false, 'non-ephemeral → keep');
    // Excluding the owning pipeline: the ephemeral one becomes orphan-eligible,
    // the user (non-ephemeral) one never is.
    assert.equal(isOrphanEphemeralAgent(eph, { exceptPipelineId: p }), true);
    assert.equal(isOrphanEphemeralAgent(user, { exceptPipelineId: p }), false);
  });

  it('keeps an ephemeral agent referenced by ANOTHER pipeline', () => {
    const eph = agent('Shared Ephemeral', 1);
    const p1 = `pipe-a-${Date.now()}`; const p2 = `pipe-b-${Date.now()}`;
    pipeline(p1, [eph]); pipeline(p2, [eph]);
    assert.equal(isOrphanEphemeralAgent(eph, { exceptPipelineId: p1 }), false, 'still used by p2 → keep');
  });

  it('keeps an ephemeral agent that is a staff assignment', () => {
    const eph = agent('Staff-backed Ephemeral', 1);
    const sid = `staff-${Date.now()}`;
    db.prepare('INSERT INTO staff_profiles (id, recipe_id, role_key, display_name, assigned_agent_id) VALUES (?, ?, ?, ?, ?)')
      .run(sid, 'r', 'k', 'S', eph);
    made.staff.push(sid);
    assert.equal(isOrphanEphemeralAgent(eph, { exceptPipelineId: 'anything' }), false);
  });

  it('pruneOwnedAgents deletes only the eligible agents', () => {
    const eph = agent('Prune Me', 1);
    const user = agent('Keep Me', 0);
    const p = `pipe-prune-${Date.now()}`;
    pipeline(p, [eph, user]);
    const removed = pruneOwnedAgents([eph, user], { exceptPipelineId: p });
    assert.deepEqual(removed, [eph]);
    assert.equal(readAgent(eph), null, 'ephemeral agent deleted');
    assert.ok(readAgent(user), 'user agent kept');
  });
});
