const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const staff = require('../lib/staffDirectory');
const { buildRecipeWorkerConfigs } = require('../lib/colonyRecipes');
const { readAgent } = require('../lib/agentParser');

beforeEach(() => {
  db.prepare('DELETE FROM staff_operator_suggestions').run();
  db.prepare('DELETE FROM staff_profiles').run();
  db.prepare('DELETE FROM colony_blackboard').run();
  db.prepare('DELETE FROM colony_handoffs').run();
  db.prepare('DELETE FROM colonies').run();
  db.prepare("DELETE FROM app_settings WHERE key='staff_assigned_agents_backfilled_v1'").run();
  db.prepare('DELETE FROM agents').run();
});

describe('staff profiles', () => {
  it('seeds durable profiles from colony recipe roles', () => {
    const profiles = staff.listProfiles();
    const developer = profiles.find(p => p.recipe_id === 'development_team' && p.role_key === 'software_developer');
    assert.ok(developer);
    assert.equal(developer.display_name, 'Sam Rivera');
    assert.ok(developer.tools.includes('sandbox'));
  });

  it('updates profile fields', () => {
    const profile = staff.listProfiles().find(p => p.role_key === 'qa_engineer');
    const updated = staff.updateProfile(profile.id, {
      display_name: 'QA Lead',
      skills: ['regression', 'accessibility'],
    });

    assert.equal(updated.display_name, 'QA Lead');
    assert.deepEqual(updated.skills, ['regression', 'accessibility']);
  });
});

describe('staff profile merge into colony workers', () => {
  it('merges staff defaults while launch model plan keeps highest precedence', () => {
    const developer = staff.listProfiles().find(p => p.role_key === 'software_developer');
    staff.updateProfile(developer.id, {
      display_name: 'Dev Custom',
      role: 'Implementation Engineer',
      model_preference: 'staff-model',
      tools: ['memory'],
      personality: 'You are a custom implementation specialist.',
      memory: 'Prefer focused patches.',
    });

    const configs = buildRecipeWorkerConfigs({ ...require('../lib/colonyRecipes').getColonyRecipe('development_team') }, 'Ship feature', 'base-model', {
      software_developer: 'launch-plan-model',
    });
    const merged = staff.applyStaffProfilesToWorkerConfigs('development_team', configs, {
      software_developer: 'launch-plan-model',
    });
    const dev = merged.find(c => c.role_key === 'software_developer');

    assert.equal(dev.name, 'Dev Custom');
    assert.equal(dev.persona_role, 'Implementation Engineer');
    assert.equal(dev.model, 'launch-plan-model');
    // Profile tools UNION with the recipe's — they can add but never strip the
    // role's capability groups (a stale profile snapshot once removed every
    // worker's handoff tool and gave the PM shell back). A role with assigned
    // skills also gains the 'skills' loader so it can pull skill bodies on demand.
    assert.deepEqual(dev.tools, ['sandbox', 'memory', 'protocol', 'protocol_worker', 'skills']);
    assert.match(dev.system_prompt, /custom implementation specialist/);
    assert.match(dev.system_prompt, /\[Staff Memory\]/);
  });

  it('uses staff model preference when launch plan does not override the role', () => {
    const researcher = staff.listProfiles().find(p => p.recipe_id === 'research_brief' && p.role_key === 'researcher');
    staff.updateProfile(researcher.id, { model_preference: 'staff-research-model' });
    const configs = buildRecipeWorkerConfigs(require('../lib/colonyRecipes').getColonyRecipe('research_brief'), 'Research goal', 'base-model', null);
    const merged = staff.applyStaffProfilesToWorkerConfigs('research_brief', configs, null);
    assert.equal(merged.find(c => c.role_key === 'researcher').model, 'staff-research-model');
  });

  it('carries the selected staff profile id through worker config for exact agent linking', () => {
    const custom = staff.createProfile({
      display_name: 'Casey QA',
      role: 'QA Engineer',
      recipe_id: 'custom',
      skills: ['regression testing'],
    });
    staff.updateProfile(custom.id, { memory: 'Prefers release-risk testing.' });

    const configs = buildRecipeWorkerConfigs(require('../lib/colonyRecipes').getColonyRecipe('development_team'), 'Regression-heavy release', 'base-model', null);
    const merged = staff.applyStaffProfilesToWorkerConfigs('development_team', configs, null, {
      requirements: 'Regression-heavy release needs QA focus',
    });
    const qa = merged.find(c => c.role_key === 'qa_engineer');

    assert.equal(qa.name, 'Casey QA');
    assert.equal(qa._staff_profile_id, custom.id);
    staff.linkAssignedAgent('development_team', 'qa_engineer', 'agent-custom-qa', qa._staff_profile_id);
    assert.equal(staff.getProfile(custom.id).assigned_agent_id, 'agent-custom-qa');
  });

  it('backfills assigned agents from existing colony runs', () => {
    const developer = staff.listProfiles().find(p => p.recipe_id === 'development_team' && p.role_key === 'software_developer');
    db.prepare(`
      INSERT INTO agents (id, name, persona_role, model, tools, system_prompt, workspace, ephemeral)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('agent-dev-old', 'Sam Rivera', 'Software Developer', 'model', '[]', '', '/tmp/agent-dev-old', 1);
    db.prepare('INSERT INTO colonies (id, goal, model, status, recipe_id, agent_ids) VALUES (?, ?, ?, ?, ?, ?)')
      .run('colony-old-link', 'Old implementation run', 'model', 'done', 'development_team', JSON.stringify(['agent-dev-old']));

    const refreshed = staff.listProfiles().find(p => p.id === developer.id);
    assert.equal(refreshed.assigned_agent_id, 'agent-dev-old');
  });

  it('creates and syncs durable agents from staff profiles', () => {
    const custom = staff.createProfile({
      display_name: 'Jordan Vale',
      role: 'Research Analyst',
      recipe_id: 'custom',
      system_prompt: 'Validate claims before summarizing.',
      personality: 'Crisp and source-driven.',
      skills: ['source review'],
      tools: ['web_search'],
      model_preference: 'anthropic/test-model',
      avatar_color: '#123456',
    });

    const created = staff.createAgentFromProfile(custom.id, {
      name: 'Wrong Name',
      persona_role: 'Wrong Role',
      avatar_color: '#ffffff',
      tools: ['sandbox'],
      system_prompt: 'Wrong prompt.',
      model: 'openai/runtime-model',
      temperature: 1.25,
      max_tokens: 2048,
      context_length: 32768,
      reasoning: true,
    });
    assert.equal(created.created, true);
    assert.equal(created.agent.name, 'Jordan Vale');
    assert.equal(created.agent.persona_name, 'Jordan Vale');
    assert.equal(created.agent.persona_role, 'Research Analyst');
    assert.equal(created.agent.model, 'openai/runtime-model');
    assert.equal(created.agent.avatar_color, '#123456');
    assert.equal(created.agent.temperature, 1.25);
    assert.equal(created.agent.max_tokens, 2048);
    assert.equal(created.agent.context_length, 32768);
    assert.equal(created.agent.reasoning, true);
    assert.equal(created.agent.ephemeral, false);
    assert.deepEqual(created.agent.tools, ['web_search']);
    assert.match(created.agent.system_prompt, /Validate claims/);
    assert.match(created.agent.system_prompt, /\[Personality\]/);
    assert.match(created.agent.system_prompt, /\[Staff Skills\]/);
    assert.equal(staff.getProfile(custom.id).assigned_agent_id, created.agent.id);

    staff.updateProfile(custom.id, {
      display_name: 'Jordan Sync',
      system_prompt: 'Updated staff prompt.',
      tools: ['memory'],
    });
    const synced = staff.createAgentFromProfile(custom.id);
    assert.equal(synced.created, false);
    assert.equal(synced.agent.id, created.agent.id);
    assert.equal(synced.agent.name, 'Jordan Sync');
    assert.deepEqual(synced.agent.tools, ['memory']);
    assert.match(readAgent(created.agent.id).system_prompt, /Updated staff prompt/);
  });
});

describe('staff evidence', () => {
  it('creates evidence-backed suggestions from colony handoff failures and applies them', () => {
    const developer = staff.listProfiles().find(p => p.role_key === 'software_developer');
    db.prepare('INSERT INTO colonies (id, goal, model, status, recipe_id) VALUES (?, ?, ?, ?, ?)')
      .run('colony-staff-test', 'Goal', 'model', 'done', 'development_team');
    db.prepare(`
      INSERT INTO colony_handoffs (id, colony_id, from_agent, to_agent, payload, status, protocol_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('handoff-fail-1', 'colony-staff-test', 'software_developer', 'qa_engineer', '{}', 'rejected', 'failed_precondition');

    const suggestions = staff.listSuggestions(developer.id);
    const suggestion = suggestions.find(s => s.evidence_type === 'handoff_failure');
    assert.ok(suggestion);
    assert.equal(suggestion.status, 'pending');

    const applied = staff.applySuggestion(suggestion.id, `${developer.system_prompt}\n\nUse stricter handoff checks.`);
    assert.equal(applied.status, 'applied');
    assert.match(staff.getProfile(developer.id).system_prompt, /stricter handoff checks/);
  });

  it('aggregates performance metrics from handoffs and blackboard notes', () => {
    const pm = staff.listProfiles().find(p => p.role_key === 'project_manager');
    db.prepare('INSERT INTO colonies (id, goal, model, status, recipe_id) VALUES (?, ?, ?, ?, ?)')
      .run('colony-metrics-test', 'Goal', 'model', 'done', 'development_team');
    db.prepare(`
      INSERT INTO colony_handoffs (id, colony_id, from_agent, to_agent, payload, status, protocol_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('handoff-ok-1', 'colony-metrics-test', 'project_manager', 'ui_ux_designer', '{"auto_recorded":true}', 'accepted', 'ok');
    db.prepare(`
      INSERT INTO colony_blackboard (colony_id, agent, entry_type, content)
      VALUES (?, ?, ?, ?)
    `).run('colony-metrics-test', 'Project Manager', 'blocker', 'Blocked on missing board access');

    const metrics = staff.profileMetrics(pm);
    assert.equal(metrics.successful_handoffs, 1);
    assert.equal(metrics.auto_recorded_handoffs, 1);
    assert.equal(metrics.blocker_count, 1);
  });

});

describe('effective config and reset-to-recipe', () => {
  it('reports drift flags and the effective tool union', () => {
    const dev = staff.listProfiles().find(p => p.role_key === 'software_developer' && p.recipe_id === 'development_team');
    // Customize the prompt; tools untouched.
    staff.updateProfile(dev.id, { system_prompt: 'You are a fully custom developer.' });
    const updated = staff.getProfile(dev.id);
    assert.equal(updated.prompt_customized, true);

    const eff = staff.profileEffectiveConfig(dev.id);
    assert.equal(eff.prompt_source, 'profile-custom');
    assert.ok(eff.recipe_prompt.length > 100, 'recipe baseline prompt should be exposed');
    const toolNames = eff.effective_tools.map(t => t.tool);
    for (const t of ['sandbox', 'protocol', 'protocol_worker']) {
      assert.ok(toolNames.includes(t), `effective tools must include recipe capability ${t}`);
    }
  });

  it('reset-to-recipe restores the current recipe prompt and clears drift', () => {
    const dev = staff.listProfiles().find(p => p.role_key === 'software_developer' && p.recipe_id === 'development_team');
    const reset = staff.resetProfileToRecipe(dev.id, ['system_prompt']);
    assert.equal(reset.prompt_customized, false);
    assert.match(reset.system_prompt, /Software Developer/);
  });

  it('reset refuses for custom staff with no recipe role', () => {
    const custom = staff.createProfile({ display_name: 'Custom Consultant', role: 'Consultant' });
    assert.throws(() => staff.resetProfileToRecipe(custom.id), /no recipe default/);
    staff.deleteProfile(custom.id);
  });
});

describe('per-run scorecard', () => {
  it('builds one row per crewed run with step, handoff, and work stats', () => {
    const dev = staff.listProfiles().find(p => p.role_key === 'software_developer' && p.recipe_id === 'development_team');
    const log = JSON.stringify([
      { kind: 'agent_ready', agent: { name: dev.display_name, role_key: 'software_developer' } },
      { kind: 'tool_call', agent: dev.display_name, tool: 'write_file', args: {} },
      { kind: 'tool_call', agent: dev.display_name, tool: 'shell', args: {} },
      { kind: 'tool_result', agent: dev.display_name, result: { error: 'HALTED: repeated failing calls' } },
      { kind: 'tool_result', agent: 'Ari Morgan', result: { agent_name: dev.display_name, response: '(no response)' } },
    ]);
    const plan = JSON.stringify({ steps: [
      { id: '1', assigned_to: 'software_developer', status: 'done' },
      { id: '2', assigned_to: 'software_developer', status: 'blocked' },
      { id: '3', assigned_to: 'qa_engineer', status: 'pending' },
    ] });
    db.prepare('INSERT INTO colonies (id, goal, model, status, recipe_id, plan, log) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('colony-score-1', 'Goal', 'm', 'stopped', 'development_team', plan, log);
    db.prepare('INSERT INTO colony_handoffs (id, colony_id, from_agent, to_agent, payload, status, protocol_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('h1', 'colony-score-1', 'software_developer', 'qa_engineer', JSON.stringify({ summary: 'done' }), 'accepted', 'ok');
    db.prepare('INSERT INTO colony_handoffs (id, colony_id, from_agent, to_agent, payload, status, protocol_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('h2', 'colony-score-1', 'software_developer', 'qa_engineer', JSON.stringify({ summary: 'done' }), 'accepted', 'ok'); // duplicate — must dedupe

    const rows = staff.profileRunScorecard(dev);
    const row = rows.find(r => r.run_id === 'colony-score-1');
    assert.ok(row, 'crewed run must appear in the scorecard');
    assert.equal(row.steps_assigned, 2);
    assert.equal(row.steps_done, 1);
    assert.equal(row.steps_blocked, 1);
    assert.equal(row.handoffs_accepted, 1); // deduped
    assert.equal(row.files_written, 1);
    assert.equal(row.shell_commands, 1);
    assert.equal(row.breaker_trips, 1);
    assert.equal(row.silent_turns, 1);
  });

  it('excludes runs the role did not crew', () => {
    const ba = staff.listProfiles().find(p => p.role_key === 'business_analyst' && p.recipe_id === 'development_team');
    db.prepare('INSERT INTO colonies (id, goal, model, status, recipe_id, log) VALUES (?, ?, ?, ?, ?, ?)')
      .run('colony-score-2', 'Goal', 'm', 'done', 'development_team', JSON.stringify([
        { kind: 'agent_ready', agent: { name: 'Someone Else', role_key: 'qa_engineer' } },
      ]));
    const rows = staff.profileRunScorecard(ba);
    assert.ok(!rows.some(r => r.run_id === 'colony-score-2'));
  });
});
