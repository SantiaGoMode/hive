const { describe, it, after, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const db = require('../db');
const protocol = require('../lib/colonyProtocol');
const { executeTool } = require('../lib/agentTools');
const { createColony, getColony, categorizeMcpServer, mcpCategoriesForWorker } = require('../lib/colonyRunner');
const { writeAgent, listAgents, deleteAgent } = require('../lib/agentParser');
const { buildRecipeWorkerConfigs, getColonyRecipe } = require('../lib/colonyRecipes');
const colonyModels = require('../lib/colonyModels');

// ── Helpers ───────────────────────────────────────────────────────────────────
const createdColonies = [];
function newDevColony() {
  const id = createColony('Ship a feature', 'qwen2.5:7b', 'development_team');
  createdColonies.push(id);
  return id;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/colony', require('../routes/colony'));
  return app;
}
const app = buildApp();
let server;

before(async () => {
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
});

after(() => {
  try { server?.close(); } catch {}
  for (const id of createdColonies) {
    try { db.prepare('DELETE FROM colonies WHERE id=?').run(id); } catch {}
    try { db.prepare('DELETE FROM colony_blackboard WHERE colony_id=?').run(id); } catch {}
    try { db.prepare('DELETE FROM colony_handoffs WHERE colony_id=?').run(id); } catch {}
  }
});

// ── 3. A2A ID cards ─────────────────────────────────────────────────────────
describe('agent cards (.agent.json / A2A)', () => {
  it('builds a card with input/output schema and handoff edges', () => {
    const card = protocol.buildAgentCard('development_team', 'software_developer', { colonyId: 'c1' });
    assert.equal(card.key, 'software_developer');
    assert.equal(card.schema_version, protocol.CARD_SCHEMA_VERSION);
    assert.ok(card.input_schema && card.output_schema);
    assert.deepEqual(card.accepts_handoff_from, ['ui_ux_designer']);
    assert.equal(card.hands_off_to[0].to, 'qa_engineer');
    // No in-run human gates — the human review point is the final Draft PR.
    assert.equal(card.hands_off_to[0].requires_human, false);
    assert.match(card.endpoints.acp_message, /\/api\/colony\/c1\/acp\/messages/);
  });

  it('builds one card per role for the dev team', () => {
    const cards = protocol.buildAllCards('development_team');
    assert.equal(cards.length, 6);
  });

  it('returns null for an unknown recipe', () => {
    assert.equal(protocol.buildAgentCard('nope', 'x'), null);
  });
});

// ── 5. Preconditions / ordering ────────────────────────────────────────────
describe('handoff preconditions (rules of engagement)', () => {
  beforeEach(() => {});

  it('rejects an undefined edge as not_understood', () => {
    const id = newDevColony();
    const r = protocol.checkPreconditions(id, 'development_team', 'business_analyst', 'devops_engineer');
    assert.equal(r.ok, false);
    assert.equal(r.protocol_status, 'not_understood');
  });

  it('blocks the developer until upstream handoffs exist, then allows it', () => {
    const id = newDevColony();
    // UX→Developer requires BA→PM and PM→UX first.
    let r = protocol.checkPreconditions(id, 'development_team', 'ui_ux_designer', 'software_developer');
    assert.equal(r.ok, false);
    assert.equal(r.protocol_status, 'precondition_failed');
    assert.ok(r.missing.length >= 1);

    // Satisfy the upstream edges.
    protocol.recordHandoff(id, { fromRole: 'business_analyst', toRole: 'project_manager', payload: {}, status: 'pending' });
    protocol.recordHandoff(id, { fromRole: 'project_manager', toRole: 'ui_ux_designer', payload: {}, status: 'pending' });

    r = protocol.checkPreconditions(id, 'development_team', 'ui_ux_designer', 'software_developer');
    assert.equal(r.ok, true);
    assert.equal(r.edge.to, 'software_developer');
  });

  it('treats a human-gated handoff as unsatisfied until approved', () => {
    const id = newDevColony();
    protocol.recordHandoff(id, { fromRole: 'business_analyst', toRole: 'project_manager', payload: {}, status: 'pending' });
    protocol.recordHandoff(id, { fromRole: 'project_manager', toRole: 'ui_ux_designer', payload: {}, status: 'pending' });
    protocol.recordHandoff(id, { fromRole: 'ui_ux_designer', toRole: 'software_developer', payload: {}, status: 'pending' });
    // Developer→QA is human-gated; record it as awaiting_human.
    protocol.recordHandoff(id, { fromRole: 'software_developer', toRole: 'qa_engineer', payload: {}, requiresHuman: true, status: 'awaiting_human' });

    // QA→DevOps must NOT be allowed yet — the dev→QA gate is unapproved.
    let r = protocol.checkPreconditions(id, 'development_team', 'qa_engineer', 'devops_engineer');
    assert.equal(r.ok, false);

    // Approve the gate.
    const pending = protocol.listHandoffs(id).find(h => h.from_agent === 'software_developer');
    protocol.updateHandoff(pending.id, { status: 'approved' });
    r = protocol.checkPreconditions(id, 'development_team', 'qa_engineer', 'devops_engineer');
    assert.equal(r.ok, true);
  });
});

// ── 1. Blackboard append semantics ───────────────────────────────────────────
describe('blackboard', () => {
  it('appends entries instead of overwriting', () => {
    const id = newDevColony();
    protocol.writeBlackboard(id, 'Business Analyst', 'state', 'first');
    protocol.writeBlackboard(id, 'Project Manager', 'blocker', 'second');
    const all = protocol.readBlackboard(id);
    assert.equal(all.length, 2);
    assert.equal(all[0].content, 'first');
    assert.equal(all[1].entry_type, 'blocker');
    const blockers = protocol.readBlackboard(id, { entryType: 'blocker' });
    assert.equal(blockers.length, 1);
  });
});

// ── Protocol tools (via executeTool) ─────────────────────────────────────────
describe('protocol tools', () => {
  function ctx(id, roleByAgentId) {
    return { colonyId: id, recipeId: 'development_team', roleByAgentId };
  }

  it('blackboard_write/read round-trip and gate outside a colony', async () => {
    const id = newDevColony();
    const out = await executeTool('blackboard_write', { content: 'hello team', entry_type: 'state' },
      'agentX', 'http://x', 0, null, null, null, 20, null, ctx(id, new Map([['agentX', 'business_analyst']])));
    assert.equal(out.success, true);
    assert.equal(out.agent, 'Business Analyst');

    const read = await executeTool('blackboard_read', {}, 'agentX', 'http://x', 0, null, null, null, 20, null, ctx(id));
    assert.equal(read.count, 1);

    const noColony = await executeTool('blackboard_write', { content: 'x' }, 'a', 'http://x', 0, null, null, null, 20, null, {});
    assert.ok(noColony.error);
  });

  it('handoff returns a protocol violation when out of order', async () => {
    const id = newDevColony();
    const map = new Map([['devAgent', 'ui_ux_designer']]);
    const out = await executeTool('handoff',
      { to_role: 'software_developer', summary: 'done', payload: { specs: 'x' } },
      'devAgent', 'http://x', 0, null, null, null, 20, null, ctx(id, map));
    assert.equal(out.ok, false);
    assert.equal(out.type, 'protocol_violation');
  });

  it('handoff succeeds in order and emits a command object', async () => {
    const id = newDevColony();
    const map = new Map([['ba', 'business_analyst']]);
    const out = await executeTool('handoff',
      { to_role: 'project_manager', summary: 'rules validated', payload: { rules: ['r1'] } },
      'ba', 'http://x', 0, null, null, null, 20, null, ctx(id, map));
    assert.equal(out.success, true);
    assert.equal(out.command.target_agent, 'project_manager');
    assert.equal(out.command.from, 'business_analyst');
    assert.equal(out.command.contract, 'Validated Business Rules & Logic Map');
  });

  it('exposes handoff to workers but not to the operator tool groups', () => {
    const { getToolDefinitions } = require('../lib/tools/registry');
    const operatorTools = getToolDefinitions(['colony_tools', 'delegation', 'protocol']).map(d => d.function.name);
    assert.ok(!operatorTools.includes('handoff'), 'operator must not see the handoff tool');
    assert.ok(operatorTools.includes('blackboard_read'));
    const workerTools = getToolDefinitions(['memory', 'protocol', 'protocol_worker']).map(d => d.function.name);
    assert.ok(workerTools.includes('handoff'));
  });

  it('report_acceptance is QA-only when a roster exists', async () => {
    const id = newDevColony();
    const map = new Map([['ba', 'business_analyst'], ['qa', 'qa_engineer']]);
    const denied = await executeTool('report_acceptance',
      { results: [{ criterion: 'env replicated', status: 'pass', evidence: 'none' }] },
      'ba', 'http://x', 0, null, null, null, 20, null, ctx(id, map));
    assert.match(denied.error, /QA Engineer/);
    const ok = await executeTool('report_acceptance',
      { results: [{ criterion: 'env replicated', status: 'fail', evidence: 'npm test exited 1' }] },
      'qa', 'http://x', 0, null, null, null, 20, null, ctx(id, map));
    assert.equal(ok.success, true);
  });

  it('sandbox_files exposes file tools but no execution tools (PM role)', () => {
    const { getToolDefinitions } = require('../lib/tools/registry');
    const pmTools = getToolDefinitions(['sandbox_files']).map(d => d.function.name);
    for (const t of ['write_file', 'read_file', 'list_files', 'move_file', 'delete_file']) {
      assert.ok(pmTools.includes(t), `sandbox_files must include ${t}`);
    }
    for (const t of ['shell', 'run_python', 'install_package', 'start_server']) {
      assert.ok(!pmTools.includes(t), `sandbox_files must NOT include ${t}`);
    }
    // The dev-team PM role must not carry the full sandbox group.
    const { getColonyRecipe } = require('../lib/colonyRecipes');
    const pm = getColonyRecipe('development_team').roles.find(r => r.key === 'project_manager');
    assert.ok(!pm.tools.includes('sandbox'));
    assert.ok(pm.tools.includes('sandbox_files'));
  });

  it('rejects a handoff from an agent not on the worker roster (operator impersonation)', async () => {
    const id = newDevColony();
    // Roster exists, but the caller ("orch") is not on it — claiming a worker's
    // from_role must not be honored, or forged handoffs auto-complete plan steps.
    const map = new Map([['ba', 'business_analyst']]);
    const out = await executeTool('handoff',
      { to_role: 'project_manager', summary: 'forged', from_role: 'business_analyst', payload: {} },
      'orch', 'http://x', 0, null, null, null, 20, null, ctx(id, map));
    assert.equal(out.success, undefined);
    assert.match(out.error, /worker tool/);
    assert.equal(protocol.listHandoffs(id).length, 0);
  });

  it('records under the registered role when from_role claims a different one', async () => {
    const id = newDevColony();
    const map = new Map([['ba', 'business_analyst']]);
    const out = await executeTool('handoff',
      { to_role: 'project_manager', summary: 'rules validated', from_role: 'qa_engineer', payload: {} },
      'ba', 'http://x', 0, null, null, null, 20, null, ctx(id, map));
    assert.equal(out.success, true);
    assert.equal(out.command.from, 'business_analyst');
    assert.match(out.note, /registered role/);
  });

  it('handoff auto-advance only completes steps assigned to the handing-off role', async () => {
    const id = newDevColony();
    db.prepare('UPDATE colonies SET plan=? WHERE id=?').run(JSON.stringify({
      steps: [
        { id: '1', description: 'env setup', assigned_to: 'software_developer', status: 'pending' },
        { id: '2', description: 'validate rules', assigned_to: 'business_analyst', status: 'pending' },
      ],
    }), id);
    const map = new Map([['ba', 'business_analyst']]);
    const out = await executeTool('handoff',
      { to_role: 'project_manager', summary: 'rules validated', payload: {} },
      'ba', 'http://x', 0, null, null, null, 20, null, ctx(id, map));
    assert.equal(out.success, true);
    const plan = JSON.parse(db.prepare('SELECT plan FROM colonies WHERE id=?').get(id).plan);
    assert.equal(plan.steps.find(s => s.id === '1').status, 'pending');   // developer's step untouched
    assert.equal(plan.steps.find(s => s.id === '2').status, 'done');      // BA's own step completed
  });

  it('the dev→QA handoff is accepted without a human gate (review happens on the Draft PR)', async () => {
    const id = newDevColony();
    // Seed upstream edges so the dev→QA preconditions pass.
    protocol.recordHandoff(id, { fromRole: 'business_analyst', toRole: 'project_manager', payload: {}, status: 'pending' });
    protocol.recordHandoff(id, { fromRole: 'project_manager', toRole: 'ui_ux_designer', payload: {}, status: 'pending' });
    protocol.recordHandoff(id, { fromRole: 'ui_ux_designer', toRole: 'software_developer', payload: {}, status: 'pending' });
    const map = new Map([['dev', 'software_developer']]);
    const out = await executeTool('handoff',
      { to_role: 'qa_engineer', summary: 'PR ready', payload: { pr: 'http://pr/1' } },
      'dev', 'http://x', 0, null, null, null, 20, null, ctx(id, map));
    assert.equal(out.success, true);
    assert.equal(out.status, 'accepted');
    assert.ok(!out.requires_human);
  });

  it('report_protocol_violation returns the not-understood envelope', async () => {
    const id = newDevColony();
    const out = await executeTool('report_protocol_violation', { reason: 'task not recognised' },
      'x', 'http://x', 0, null, null, null, 20, null, ctx(id, new Map([['x', 'qa_engineer']])));
    assert.equal(out.type, 'protocol_violation');
    assert.equal(out.performative, 'not-understood');
  });
});

// ── REST surface ──────────────────────────────────────────────────────────────
describe('A2A/ACP REST endpoints', () => {
  it('serves the recipe flow + cards', async () => {
    const res = await request(server).get('/api/colony/recipes/development_team/flow');
    assert.equal(res.status, 200);
    assert.equal(res.body.flow.length, 6);
    assert.equal(res.body.cards.length, 6);
  });

  it('404s the flow for a recipe without a protocol', async () => {
    const res = await request(server).get('/api/colony/recipes/research_brief/flow');
    assert.equal(res.status, 404);
  });

  it('reads and appends the blackboard, and lists agent cards', async () => {
    const id = newDevColony();
    let res = await request(server).post(`/api/colony/${id}/blackboard`).send({ agent: 'external', content: 'kickoff' });
    assert.equal(res.status, 200);
    res = await request(server).get(`/api/colony/${id}/blackboard`);
    assert.equal(res.body.count, 1);
    res = await request(server).get(`/api/colony/${id}/agents`);
    assert.equal(res.body.protocol, true);
    assert.equal(res.body.cards.length, 6);
  });

  it('approves a human-in-the-loop handoff', async () => {
    const id = newDevColony();
    const h = protocol.recordHandoff(id, { fromRole: 'software_developer', toRole: 'qa_engineer', payload: {}, requiresHuman: true, status: 'awaiting_human' });
    const res = await request(server).post(`/api/colony/${id}/handoffs/${h.id}/approve`).send({ decision: 'approved', note: 'LGTM' });
    assert.equal(res.status, 200);
    assert.equal(res.body.handoff.status, 'approved');
    assert.equal(res.body.handoff.human_note, 'LGTM');
  });

  it('rejects an invalid approval decision', async () => {
    const id = newDevColony();
    const h = protocol.recordHandoff(id, { fromRole: 'qa_engineer', toRole: 'devops_engineer', payload: {}, requiresHuman: true, status: 'awaiting_human' });
    const res = await request(server).post(`/api/colony/${id}/handoffs/${h.id}/approve`).send({ decision: 'maybe' });
    assert.equal(res.status, 400);
  });
});

// ── #3 Protocol-gated completion + deliverable ───────────────────────────────
describe('flow completion gate', () => {
  it('blocks completion when the flow was never used', () => {
    const id = newDevColony();
    const c = protocol.flowCompletion(id, 'development_team');
    assert.equal(c.ok, false);
    assert.match(c.reason, /No handoffs/);
  });

  it('auto-approves legacy awaiting_human handoffs instead of blocking completion', () => {
    const id = newDevColony();
    protocol.recordHandoff(id, { fromRole: 'business_analyst', toRole: 'project_manager', payload: {}, status: 'pending' });
    protocol.recordHandoff(id, { fromRole: 'software_developer', toRole: 'qa_engineer', payload: {}, requiresHuman: true, status: 'awaiting_human' });
    const c = protocol.flowCompletion(id, 'development_team');
    assert.equal(c.ok, true);
    const legacy = protocol.listHandoffs(id).find(h => h.from_agent === 'software_developer');
    assert.equal(legacy.status, 'approved');
  });

  it('allows completion once handoffs exist and no gate is pending', () => {
    const id = newDevColony();
    protocol.recordHandoff(id, { fromRole: 'business_analyst', toRole: 'project_manager', payload: {}, status: 'accepted' });
    const c = protocol.flowCompletion(id, 'development_team');
    assert.equal(c.ok, true);
    assert.equal(c.terminal_reached, false);
  });

  it('reports terminal_reached when the last edge is satisfied', () => {
    const id = newDevColony();
    protocol.recordHandoff(id, { fromRole: 'devops_engineer', toRole: 'project_manager', payload: { contract: 'Deployment URL' }, status: 'accepted' });
    const c = protocol.flowCompletion(id, 'development_team');
    assert.equal(c.terminal_reached, true);
  });

  it('treats recipes without a protocol as always completable', () => {
    const c = protocol.flowCompletion('whatever', 'research_brief');
    assert.equal(c.ok, true);
    assert.equal(c.protocol, false);
  });
});

describe('buildDeliverable', () => {
  it('collects artifacts, links, and the handoff trail', () => {
    const id = newDevColony();
    protocol.recordHandoff(id, {
      fromRole: 'software_developer', toRole: 'qa_engineer',
      payload: { contract: 'PR Link & API Documentation', artifacts: ['https://github.com/acme/x/pull/7', 'docs/api.md'] },
      status: 'approved',
    });
    const d = protocol.buildDeliverable(id, 'development_team', 'Shipped it');
    assert.equal(d.summary, 'Shipped it');
    assert.ok(d.links.includes('https://github.com/acme/x/pull/7'));
    assert.ok(d.artifacts.includes('docs/api.md'));
    assert.equal(d.handoffs[0].contract, 'PR Link & API Documentation');
  });
});

describe('mark_goal_achieved gating', () => {
  const ctx = (id) => ({ colonyId: id, recipeId: 'development_team' });

  it('is blocked until the handoff flow is used', async () => {
    const id = newDevColony();
    const out = await executeTool('mark_goal_achieved', { summary: 'done' },
      'orch', 'http://x', 0, null, null, null, 20, null, ctx(id));
    assert.ok(out.error);
    assert.match(out.error, /handoff flow/);
  });

  it('succeeds and stores a deliverable once the flow is satisfied', async () => {
    const id = newDevColony();
    protocol.recordHandoff(id, { fromRole: 'devops_engineer', toRole: 'project_manager', payload: { contract: 'Deployment URL', artifacts: ['https://app.example.com'] }, status: 'accepted' });
    const out = await executeTool('mark_goal_achieved', { summary: 'shipped' },
      'orch', 'http://x', 0, null, null, null, 20, null, ctx(id));
    assert.equal(out.goal_achieved, true);
    assert.ok(out.deliverable);
    assert.equal(out.deliverable.flow_complete, true);
    const row = db.prepare('SELECT deliverable FROM colonies WHERE id=?').get(id);
    assert.ok(row.deliverable && JSON.parse(row.deliverable).links.includes('https://app.example.com'));
  });

  it('includes operator workaround notes in the final deliverable', async () => {
    const id = newDevColony();
    protocol.recordHandoff(id, { fromRole: 'business_analyst', toRole: 'project_manager', payload: {}, status: 'accepted' });
    protocol.recordHandoff(id, { fromRole: 'project_manager', toRole: 'ui_ux_designer', payload: {}, status: 'accepted' });
    protocol.recordHandoff(id, { fromRole: 'ui_ux_designer', toRole: 'software_developer', payload: {}, status: 'accepted' });
    protocol.recordHandoff(id, { fromRole: 'software_developer', toRole: 'qa_engineer', payload: {}, status: 'approved' });
    protocol.recordHandoff(id, { fromRole: 'qa_engineer', toRole: 'devops_engineer', payload: {}, status: 'approved' });
    protocol.recordHandoff(id, { fromRole: 'devops_engineer', toRole: 'project_manager', payload: {}, status: 'accepted' });
    db.prepare('UPDATE colonies SET plan=? WHERE id=?').run(JSON.stringify({ steps: [{ id: '1', description: 'Ship', status: 'done' }] }), id);

    const note = await executeTool('report_workaround', {
      issue: 'Sandbox unavailable',
      workaround: 'Produced a manual patch plan',
      recommendation: 'Show sandbox readiness before launch',
      impact: 'Lower verification confidence',
    }, 'operator', 'http://x', 0, null, null, null, 20, null, ctx(id, new Map([['operator', 'project_manager']])));
    assert.equal(note.success, true);

    const out = await executeTool('mark_goal_achieved', { summary: 'shipped with notes' },
      'operator', 'http://x', 0, null, null, null, 20, null, ctx(id, new Map([['operator', 'project_manager']])));
    assert.equal(out.goal_achieved, true);
    assert.equal(out.deliverable.workarounds[0].recommendation, 'Show sandbox readiness before launch');
  });
});

// ── #5 Ephemeral colony agents ───────────────────────────────────────────────
describe('ephemeral agents', () => {
  it('hides ephemeral agents from the default list but keeps them readable', () => {
    const normal = writeAgent(null, { name: 'Visible Agent', model: 'm' });
    const hidden = writeAgent(null, { name: 'Colony Worker', model: 'm', ephemeral: true });
    try {
      const ids = listAgents().map(a => a.id);
      assert.ok(ids.includes(normal.id));
      assert.ok(!ids.includes(hidden.id), 'ephemeral agent should be hidden');
      const all = listAgents({ includeEphemeral: true }).map(a => a.id);
      assert.ok(all.includes(hidden.id));
      assert.equal(require('../lib/agentParser').readAgent(hidden.id).ephemeral, true);
    } finally {
      deleteAgent(normal.id);
      deleteAgent(hidden.id);
    }
  });

  it('seeds dev-team worker configs as ephemeral', () => {
    const cfgs = buildRecipeWorkerConfigs(getColonyRecipe('development_team'), 'goal', 'm');
    assert.ok(cfgs.length === 6 && cfgs.every(c => c.ephemeral === true));
  });
});

// ── #7 Role-aware MCP attachment ─────────────────────────────────────────────
describe('role-aware MCP categorization', () => {
  it('categorizes servers by capability', () => {
    assert.deepEqual(categorizeMcpServer({ name: 'Brave Search', tool_names: ['web_search'] }), ['research']);
    assert.ok(categorizeMcpServer({ name: 'GitHub', tool_names: ['create_issue', 'get_pull_request'] }).includes('code'));
    assert.deepEqual(categorizeMcpServer({ name: 'Random Thing', tool_names: ['ping'] }), []);
  });

  it('maps roles to the categories they need', () => {
    assert.deepEqual(mcpCategoriesForWorker({ role_key: 'software_developer' }), ['code']);
    assert.deepEqual(mcpCategoriesForWorker({ role_key: 'devops_engineer' }), ['code']);
    assert.deepEqual(mcpCategoriesForWorker({ role_key: 'ui_ux_designer' }), ['research']);
    // The PM owns board upkeep (work-item comments, release notes) → code/GitHub tools.
    assert.deepEqual(mcpCategoriesForWorker({ role_key: 'project_manager' }), ['code']);
    assert.deepEqual(mcpCategoriesForWorker({ persona_role: 'Researcher' }), ['research']);
    assert.deepEqual(mcpCategoriesForWorker({ name: 'Backend Developer' }), ['code']);
  });
});

// ── #6 Per-colony repo + board linkage + write-back ──────────────────────────
describe('per-colony repo + board', () => {
  it('stores and returns repo_path and the linked board card', () => {
    const id = createColony('g', 'm', 'development_team', {
      repoPath: '/tmp/proj',
      boardCard: { id: 'issue-7', number: 7, url: 'https://github.com/a/b/issues/7', repo: 'a/b' },
    });
    createdColonies.push(id);
    const c = getColony(id);
    assert.equal(c.repo_path, '/tmp/proj');
    assert.equal(c.board_card.number, 7);
    assert.equal(c.board_card.repo, 'a/b');
  });

  it('400s a board comment when no work-item is linked', async () => {
    const id = newDevColony();
    const res = await request(server).post(`/api/colony/${id}/board/comment`).send({});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /no linked board/i);
  });
});

// ── Sprint 1: model system ───────────────────────────────────────────────────
describe('colony model planning', () => {
  const models = require('../lib/colonyModels');
  const pool = {
    ollama: [
      { id: 'llama3.1:8b', provider: 'ollama', name: 'llama3.1:8b' },
      { id: 'qwen2.5-coder:14b', provider: 'ollama', name: 'qwen2.5-coder:14b' },
    ],
    anthropic: [
      { id: 'anthropic/claude-opus-4-6', provider: 'anthropic', name: 'claude-opus-4-6' },
      { id: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', name: 'claude-sonnet-4-6' },
    ],
    openai: [], gemini: [],
  };

  it('detects and gates cloud models when cloud is disabled', () => {
    assert.equal(models.isCloudModel('anthropic/claude-opus-4-6'), true);
    assert.equal(models.isCloudModel('llama3.1:8b'), false);
    assert.equal(models.gateModel('anthropic/claude-opus-4-6', false).ok, false);
    assert.equal(models.gateModel('anthropic/claude-opus-4-6', true).ok, true);
    assert.equal(models.gateModel('llama3.1:8b', false).ok, true);
  });

  it('proposes local-only models when cloud is disabled', () => {
    const plan = models.proposeModelPlan(getColonyRecipe('development_team'), pool, { cloudEnabled: false });
    for (const m of Object.values(plan)) assert.equal(models.isCloudModel(m), false);
    // Coding role gets the coder model.
    assert.equal(plan.software_developer, 'qwen2.5-coder:14b');
  });

  it('never proposes a model annotated tools:false, even if it scores highest', () => {
    const withNonTool = {
      ollama: [
        ...pool.ollama,
        // Bigger + "coder" → would outscore everything locally if eligible.
        { id: 'deepseek-coder-v2:16b', provider: 'ollama', name: 'deepseek-coder-v2:16b', tools: false },
      ],
      anthropic: [], openai: [], gemini: [],
    };
    const plan = models.proposeModelPlan(getColonyRecipe('development_team'), withNonTool, { cloudEnabled: false });
    for (const m of Object.values(plan)) assert.notEqual(m, 'deepseek-coder-v2:16b');
    assert.equal(plan.software_developer, 'qwen2.5-coder:14b');
    // validatePlan repairs a hand-picked non-tool model the same way.
    const repaired = models.validatePlan({ software_developer: 'deepseek-coder-v2:16b' },
      getColonyRecipe('development_team'), withNonTool, { cloudEnabled: false });
    assert.notEqual(repaired.software_developer, 'deepseek-coder-v2:16b');
    // tools:null (unknown capability — old Ollama) stays eligible.
    const unknownOnly = { ollama: [{ id: 'mystery:7b', provider: 'ollama', name: 'mystery:7b', tools: null }], anthropic: [], openai: [], gemini: [] };
    const p2 = models.proposeModelPlan(getColonyRecipe('development_team'), unknownOnly, { cloudEnabled: false });
    assert.equal(p2.operator, 'mystery:7b');
  });

  it('prefers cloud flagships when cloud is enabled', () => {
    const plan = models.proposeModelPlan(getColonyRecipe('development_team'), pool, { cloudEnabled: true });
    assert.equal(plan.operator, 'anthropic/claude-opus-4-6');
    assert.ok(models.isCloudModel(plan.software_developer));
  });

  it('resolveRoleModel falls back to operator then colony model', () => {
    assert.equal(models.resolveRoleModel({ software_developer: 'x' }, 'software_developer', 'fb'), 'x');
    assert.equal(models.resolveRoleModel({ operator: 'op' }, 'qa_engineer', 'fb'), 'op');
    assert.equal(models.resolveRoleModel(null, 'qa_engineer', 'fb'), 'fb');
  });

  it('seeds workers with their planned per-role models', () => {
    const plan = { software_developer: 'qwen2.5-coder:14b', business_analyst: 'llama3.1:8b' };
    const cfgs = buildRecipeWorkerConfigs(getColonyRecipe('development_team'), 'goal', 'fallback:1b', plan);
    assert.equal(cfgs.find(c => c.role_key === 'software_developer').model, 'qwen2.5-coder:14b');
    assert.equal(cfgs.find(c => c.role_key === 'business_analyst').model, 'llama3.1:8b');
    // Unplanned role falls back.
    assert.equal(cfgs.find(c => c.role_key === 'devops_engineer').model, 'fallback:1b');
  });

  it('persists cloud_enabled and model_plan on the colony', () => {
    const id = createColony('g', 'llama3.1:8b', 'development_team', {
      cloudEnabled: true,
      modelPlan: { operator: 'anthropic/claude-opus-4-6', software_developer: 'qwen2.5-coder:14b' },
    });
    createdColonies.push(id);
    const c = getColony(id);
    assert.equal(c.cloud_enabled, true);
    assert.equal(c.model_plan.operator, 'anthropic/claude-opus-4-6');
  });

  it('normalizes and decides worker reasoning mode', () => {
    const recipe = getColonyRecipe('development_team');
    assert.equal(colonyModels.normalizeReasoningMode('wat'), 'auto');
    assert.equal(colonyModels.shouldEnableWorkerReasoning({ mode: 'off', recipe, goal: 'debug a complex failure' }), false);
    assert.equal(colonyModels.shouldEnableWorkerReasoning({ mode: 'on', recipe, goal: 'simple copy edit' }), true);
    assert.equal(colonyModels.shouldEnableWorkerReasoning({ mode: 'auto', recipe, goal: 'simple copy edit' }), true);
  });
});

describe('model system routes', () => {
  it('proposes a per-role model plan for a recipe', async () => {
    const res = await request(server).post('/api/colony/propose-models').send({ recipe_id: 'development_team', cloud_enabled: false });
    assert.equal(res.status, 200);
    assert.ok(res.body.model_plan && res.body.model_plan.operator);
    assert.ok('software_developer' in res.body.model_plan);
  });

  it('rejects launch with a cloud model when cloud is disabled', async () => {
    const res = await request(server).post('/api/colony').send({
      goal: 'g', model: 'anthropic/claude-opus-4-6', recipe_id: 'development_team', cloud_enabled: false,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /cloud model/i);
  });
});

// ── Operator-reasoned model plan (LLM proposer) ──────────────────────────────
describe('proposeModelPlanLLM', () => {
  const models = require('../lib/colonyModels');
  const recipe = getColonyRecipe('development_team');
  const pool = {
    ollama: [{ id: 'llama3.1:8b', provider: 'ollama', name: 'llama3.1:8b' }, { id: 'qwen2.5-coder:14b', provider: 'ollama', name: 'qwen2.5-coder:14b' }],
    anthropic: [{ id: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', name: 'claude-sonnet-4-6' }],
    openai: [], gemini: [],
  };

  it('uses the operator’s JSON choice when valid (source=operator)', async () => {
    const fakeProviders = { generateText: async () => '{"operator":"anthropic/claude-sonnet-4-6","software_developer":"qwen2.5-coder:14b"}' };
    const r = await models.proposeModelPlanLLM(recipe, pool, { cloudEnabled: true, providers: fakeProviders });
    assert.equal(r.source, 'operator');
    assert.equal(r.model_plan.software_developer, 'qwen2.5-coder:14b');
    // Unspecified roles are repaired from the heuristic (never empty).
    assert.ok(r.model_plan.business_analyst);
  });

  it('repairs out-of-pool / cloud-violating picks', async () => {
    const fakeProviders = { generateText: async () => '{"operator":"made-up/model","software_developer":"anthropic/claude-sonnet-4-6"}' };
    const r = await models.proposeModelPlanLLM(recipe, pool, { cloudEnabled: false, providers: fakeProviders });
    // cloud disabled → the cloud dev pick is rejected and repaired to a local model
    assert.equal(models.isCloudModel(r.model_plan.software_developer), false);
    assert.equal(models.isCloudModel(r.model_plan.operator), false);
  });

  it('falls back to heuristic on bad output', async () => {
    const fakeProviders = { generateText: async () => 'sorry, no JSON here' };
    const r = await models.proposeModelPlanLLM(recipe, pool, { cloudEnabled: true, providers: fakeProviders });
    assert.equal(r.source, 'heuristic');
    assert.ok(r.model_plan.operator);
  });
});

// ── Sprint 2: coding guidelines + permission circuit-breaker ─────────────────
describe('coding guidelines', () => {
  const { readRepoGuidelines } = require('../lib/codingGuidelines');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  it('injects the ruleset into coding roles only', () => {
    const cfgs = buildRecipeWorkerConfigs(getColonyRecipe('development_team'), 'goal', 'm');
    const dev = cfgs.find(c => c.role_key === 'software_developer');
    const ba = cfgs.find(c => c.role_key === 'business_analyst');
    assert.match(dev.system_prompt, /Coding Guidelines/);
    assert.ok(!/Coding Guidelines/.test(ba.system_prompt));
  });

  it('reads a repo AGENTS.md when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Use tabs not spaces.');
    const block = readRepoGuidelines(dir);
    assert.match(block, /authoritative/);
    assert.match(block, /Use tabs not spaces/);
    assert.equal(readRepoGuidelines('/no/such/path'), '');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('permission circuit-breaker', () => {
  const { isPermissionError } = require('../lib/agentTools');
  it('classifies permission/auth errors', () => {
    assert.equal(isPermissionError({ error: 'GitHub API: 403 Forbidden' }), true);
    assert.equal(isPermissionError({ error: 'permission denied (publickey)' }), true);
    assert.equal(isPermissionError({ error: 'requires the repo scope' }), true);
    assert.equal(isPermissionError({ error: 'No API key set' }), true);
    assert.equal(isPermissionError({ error: 'file not found' }), false);
    assert.equal(isPermissionError({ result: 'ok' }), false);
  });
});
