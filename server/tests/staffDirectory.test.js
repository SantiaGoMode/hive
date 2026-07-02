const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const staff = require('../lib/staffDirectory');
const staffScheduler = require('../lib/staffScheduler');
const { buildRecipeWorkerConfigs } = require('../lib/colonyRecipes');

beforeEach(() => {
  db.prepare('DELETE FROM staff_chat_messages').run();
  db.prepare('DELETE FROM staff_operator_suggestions').run();
  db.prepare('DELETE FROM staff_profiles').run();
  db.prepare('DELETE FROM colony_blackboard').run();
  db.prepare('DELETE FROM colony_handoffs').run();
  db.prepare('DELETE FROM colonies').run();
  db.prepare("DELETE FROM app_settings WHERE key='staff_assigned_agents_backfilled_v1'").run();
  db.prepare('DELETE FROM agents').run();
});

describe('staff profiles', () => {
  it('seeds durable profiles from colony recipe roles with 10 minute chat default', () => {
    const profiles = staff.listProfiles();
    const developer = profiles.find(p => p.recipe_id === 'development_team' && p.role_key === 'software_developer');
    assert.ok(developer);
    assert.equal(developer.display_name, 'Sam Rivera');
    assert.equal(developer.chat_enabled, false);
    assert.equal(developer.chat_interval_minutes, 10);
    assert.ok(developer.tools.includes('sandbox'));
  });

  it('updates profile fields', () => {
    const profile = staff.listProfiles().find(p => p.role_key === 'qa_engineer');
    const updated = staff.updateProfile(profile.id, {
      display_name: 'QA Lead',
      skills: ['regression', 'accessibility'],
      chat_enabled: true,
      chat_interval_minutes: 7,
    });

    assert.equal(updated.display_name, 'QA Lead');
    assert.deepEqual(updated.skills, ['regression', 'accessibility']);
    assert.equal(updated.chat_enabled, true);
    assert.equal(updated.chat_interval_minutes, 7);
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
    // worker's handoff tool and gave the PM shell back).
    assert.deepEqual(dev.tools, ['sandbox', 'memory', 'protocol', 'protocol_worker']);
    assert.match(dev.system_prompt, /custom implementation specialist/);
    assert.match(dev.system_prompt, /\[Staff Memory\]/);
  });

  it('uses staff model preference when launch plan does not override the role', () => {
    const researcher = staff.listProfiles().find(p => p.role_key === 'researcher');
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
});

describe('staff evidence and chat', () => {
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

  it('detects mentions in Staff chat without writing colony directions', () => {
    const qa = staff.listProfiles().find(p => p.role_key === 'qa_engineer');
    const mentions = staff.detectMentions('Can @qa_engineer look at this?').map(p => p.id);
    staff.addChatMessage({ authorType: 'user', content: 'Can @qa_engineer look at this?', mentions });

    assert.deepEqual(mentions, [qa.id]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM colony_directions').get().n, 0);
  });

  it('does not answer mentions for profiles with chat disabled', async () => {
    const qa = staff.listProfiles().find(p => p.role_key === 'qa_engineer');
    staff.updateProfile(qa.id, { model_preference: 'fake-model', chat_enabled: false });
    const message = staff.addChatMessage({
      authorType: 'user',
      content: 'Can @qa_engineer look at this?',
      mentions: [qa.id],
      triggerType: 'manual',
    });

    const responses = await staffScheduler.generateMentionResponses(message);
    assert.deepEqual(responses, []);
  });

  it('allows scheduled staff chat to stay silent instead of forcing filler', () => {
    const qa = staff.listProfiles().find(p => p.role_key === 'qa_engineer');
    const prompt = staff.buildStaffChatMessages(qa, 'interval');

    assert.match(prompt.messages.at(-1).content, /reply exactly: SILENCE/);
    assert.match(prompt.system, /casual AI-teammate chat/);
    assert.match(prompt.system, /never pretend to have a body/);
    assert.doesNotMatch(prompt.system, /RECENT RUN FACTS/);
    assert.equal(staff.isAwkwardChatOutput('### Standup update\n- fake item'), true);
    assert.equal(staff.isAwkwardChatOutput('I grabbed a sandwich before looking at this.'), true);
    assert.equal(staff.isAwkwardChatOutput('I could use a coffee before naming another variable.'), true);
    assert.equal(staff.isAwkwardChatOutput('I do not know yet.'), false);
    assert.equal(staff.isAwkwardChatOutput('Naming things remains the final boss of software.'), false);
  });

  it('keeps colony work out of Staff chat prompt context', () => {
    const developer = staff.listProfiles().find(p => p.recipe_id === 'development_team' && p.role_key === 'software_developer');
    db.prepare(`
      INSERT INTO agents (id, name, persona_role, model, tools, system_prompt, workspace, ephemeral)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('agent-dev-chat', 'Sam Rivera', 'Software Developer', 'model', '[]', '', '/tmp/agent-dev-chat', 1);
    db.prepare('INSERT INTO colonies (id, goal, model, status, recipe_id, agent_ids, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('colony-chat-hidden', 'Ship the payment regression fix', 'model', 'done', 'development_team', JSON.stringify(['agent-dev-chat']), 'Regression fixed.');

    const prompt = staff.buildStaffChatMessages(developer, 'interval');
    assert.doesNotMatch(prompt.system, /payment regression|Regression fixed|colony-chat-hidden/);
    assert.equal(staff.isAwkwardChatOutput('The regression build is ready.'), true);
    assert.equal(staff.isUngroundedWorkClaim(developer, 'Let’s keep task details in the Colony chat.', ''), false);
  });

  it('rejects work claims in staff chat even when grounded elsewhere', () => {
    const qa = staff.listProfiles().find(p => p.role_key === 'qa_engineer');

    assert.equal(staff.isUngroundedWorkClaim(qa, 'The latest build passed regression.', ''), true);
    const grounded = staff.updateProfile(qa.id, { memory: 'Regression testing happened for the checkout flow.' });
    assert.equal(staff.isUngroundedWorkClaim(grounded, 'Regression testing still needs attention.', ''), true);
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
