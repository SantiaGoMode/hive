// Expanded recipe catalog (technical + business presets): recipe listing,
// strict-flow exposure and enforcement, staff seeding, and the role-metadata
// plumbing that drives model choice, repo access, network, MCP attachment,
// and coding-guideline injection.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const db = require('../db');
const protocol = require('../lib/colonyProtocol');
const colonyModels = require('../lib/colonyModels');
const staff = require('../lib/staffDirectory');
const {
  listColonyRecipes, getColonyRecipe, isCodingRoleKey, buildRecipeWorkerConfigs, recipeOrchestratorPrompt,
} = require('../lib/colonyRecipes');
const { workerIsCoding, workerRepoAccess, workerNetwork } = require('../lib/colony/seeding');
const { mcpCategoriesForWorker } = require('../lib/colony/mcp');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/colony', require('../routes/colony'));
  return app;
}
const app = buildApp();

// Expected role counts per new recipe (from the issue spec).
const EXPECTED_ROLE_COUNTS = {
  code_review: 5,
  incident_response: 6,
  product_discovery: 6,
  docs_release: 5,
  data_analysis: 5,
  security_review: 5,
  refactor_migration: 5,
  content_pipeline: 6,
  go_to_market_launch: 6,
  marketing_campaign: 5,
  content_marketing: 6,
  sales_enablement: 5,
  revenue_operations: 5,
  customer_success: 5,
  business_strategy: 5,
  operations_improvement: 5,
  vendor_procurement: 5,
  partnerships: 5,
  hiring_pipeline: 5,
  support_operations: 5,
};

const STRICT_RECIPES = [
  'code_review', 'incident_response', 'docs_release', 'security_review', 'refactor_migration',
  'go_to_market_launch', 'marketing_campaign', 'sales_enablement', 'revenue_operations',
  'customer_success', 'operations_improvement', 'vendor_procurement',
];
const LIGHTWEIGHT_RECIPES = [
  'product_discovery', 'data_analysis', 'content_pipeline', 'content_marketing',
  'business_strategy', 'partnerships', 'hiring_pipeline', 'support_operations',
];

const cleanupHandoffColonies = [];
after(() => {
  for (const id of cleanupHandoffColonies) {
    try { db.prepare('DELETE FROM colony_handoffs WHERE colony_id=?').run(id); } catch {}
  }
});

describe('expanded recipe catalog — listing', () => {
  it('serves every new recipe from /api/colony/recipes with the expected role counts', async () => {
    const res = await request(app).get('/api/colony/recipes').expect(200);
    const byId = Object.fromEntries(res.body.map(r => [r.id, r]));
    for (const [rid, count] of Object.entries(EXPECTED_ROLE_COUNTS)) {
      assert.ok(byId[rid], `recipe ${rid} missing from /api/colony/recipes`);
      assert.equal(byId[rid].roles.length, count, `${rid} should expose ${count} roles`);
    }
    // Founding recipes are untouched.
    assert.equal(byId.development_team.roles.length, 6);
    assert.equal(byId.research_brief.roles.length, 4);
    assert.equal(byId.custom_auto.roles.length, 0);
  });

  it('keeps the /api/colony/recipes response shape free of internal role metadata', async () => {
    const res = await request(app).get('/api/colony/recipes').expect(200);
    for (const recipe of res.body) {
      assert.deepEqual(
        Object.keys(recipe).sort(),
        ['category', 'execution_policy', 'id', 'name', 'placeholder', 'roles', 'summary'],
        `${recipe.id} response shape changed`,
      );
      for (const role of recipe.roles) {
        assert.deepEqual(
          Object.keys(role).sort(),
          ['agent_name', 'key', 'name', 'role', 'tools'],
          `${recipe.id}/${role.key} leaks internal metadata`,
        );
      }
    }
  });

  it('every strict-flow role key exists in its recipe, and the flow covers all roles', () => {
    for (const rid of STRICT_RECIPES) {
      const recipe = getColonyRecipe(rid);
      assert.equal(recipe.id, rid, `${rid} must resolve (not fall back to custom_auto)`);
      const roleKeys = new Set(recipe.roles.map(r => r.key));
      const flow = protocol.getFlow(rid);
      const flowKeys = new Set(flow.flatMap(e => [e.from, e.to]));
      for (const key of flowKeys) assert.ok(roleKeys.has(key), `${rid}: flow role ${key} missing from recipe`);
      for (const key of roleKeys) assert.ok(flowKeys.has(key), `${rid}: role ${key} not part of the flow chain`);
    }
  });
});

describe('expanded recipe catalog — strict flows', () => {
  it('exposes /api/colony/recipes/:rid/flow with cards for every strict recipe', async () => {
    for (const rid of STRICT_RECIPES) {
      const res = await request(app).get(`/api/colony/recipes/${rid}/flow`).expect(200);
      assert.equal(res.body.recipe_id, rid);
      assert.ok(Array.isArray(res.body.flow) && res.body.flow.length >= 4, `${rid} flow should have edges`);
      const roleCount = getColonyRecipe(rid).roles.length;
      assert.equal(res.body.cards.length, roleCount, `${rid} should build one card per role`);
      for (const card of res.body.cards) {
        assert.equal(card.schema_version, protocol.CARD_SCHEMA_VERSION);
        assert.ok(Array.isArray(card.hands_off_to));
      }
    }
  });

  it('404s the flow lookup for lightweight recipes', async () => {
    for (const rid of LIGHTWEIGHT_RECIPES) {
      const res = await request(app).get(`/api/colony/recipes/${rid}/flow`);
      assert.equal(res.status, 404, `${rid} must not expose a protocol flow`);
    }
  });

  it('enforces handoff ordering — a downstream handoff fails until upstream edges are recorded', () => {
    const colonyId = 'recipe-catalog-order-test';
    cleanupHandoffColonies.push(colonyId);
    const flow = protocol.getFlow('marketing_campaign');

    // Jumping to the 3rd edge without the first two on record is refused.
    const early = protocol.checkPreconditions(colonyId, 'marketing_campaign', flow[2].from, flow[2].to);
    assert.equal(early.ok, false);
    assert.equal(early.protocol_status, 'precondition_failed');
    assert.equal(early.missing.length, 2);

    // An undefined edge is not_understood.
    const bogus = protocol.checkPreconditions(colonyId, 'marketing_campaign', flow[0].from, flow[3].to);
    assert.equal(bogus.ok, false);
    assert.equal(bogus.protocol_status, 'not_understood');

    // Recording the chain in order makes each next edge valid.
    for (const edge of flow) {
      const check = protocol.checkPreconditions(colonyId, 'marketing_campaign', edge.from, edge.to);
      assert.equal(check.ok, true, `${edge.from}→${edge.to} should be valid in order: ${check.reason || ''}`);
      protocol.recordHandoff(colonyId, { fromRole: edge.from, toRole: edge.to, payload: { contract: edge.payload }, status: 'accepted' });
    }
  });

  it('blocks premature completion and reports missing edges until the chain finishes', () => {
    const colonyId = 'recipe-catalog-completion-test';
    cleanupHandoffColonies.push(colonyId);
    const flow = protocol.getFlow('vendor_procurement');

    // No handoffs at all → completion refused.
    const none = protocol.flowCompletion(colonyId, 'vendor_procurement');
    assert.equal(none.ok, false);
    assert.match(none.reason, /No handoffs recorded/);

    // First edge only → ok:true but terminal not reached, remaining edges listed.
    protocol.recordHandoff(colonyId, { fromRole: flow[0].from, toRole: flow[0].to, payload: {}, status: 'accepted' });
    const partial = protocol.flowCompletion(colonyId, 'vendor_procurement');
    assert.equal(partial.ok, true);
    assert.equal(partial.terminal_reached, false);
    assert.equal(partial.missing_edges.length, flow.length - 1);

    // Full chain → terminal reached, nothing missing.
    for (const edge of flow.slice(1)) {
      protocol.recordHandoff(colonyId, { fromRole: edge.from, toRole: edge.to, payload: {}, status: 'accepted' });
    }
    const done = protocol.flowCompletion(colonyId, 'vendor_procurement');
    assert.equal(done.terminal_reached, true);
    assert.equal(done.missing_edges.length, 0);
  });

  it('lightweight recipes report protocol:false from flowCompletion (no enforcement)', () => {
    const completion = protocol.flowCompletion('no-such-colony', 'business_strategy');
    assert.deepEqual(completion, { ok: true, protocol: false });
  });
});

describe('expanded recipe catalog — staff profile seeding', () => {
  it('seeds a staff profile for every role of every new recipe', () => {
    const profiles = staff.listProfiles();
    for (const rid of Object.keys(EXPECTED_ROLE_COUNTS)) {
      const recipe = getColonyRecipe(rid);
      for (const role of recipe.roles) {
        const profile = profiles.find(p => p.recipe_id === rid && p.role_key === role.key);
        assert.ok(profile, `no staff profile seeded for ${rid}/${role.key}`);
        assert.equal(profile.display_name, role.agent_name);
        assert.deepEqual(profile.tools, role.tools);
        assert.ok(profile.system_prompt.includes(`You are the ${role.role}`), `${rid}/${role.key} prompt not seeded`);
      }
    }
  });

  it('unedited profiles auto-sync when the recipe prompt changes (drift repair)', () => {
    const profile = staff.getProfileByRole('code_review', 'review_lead');
    assert.ok(profile);
    // Simulate a stale seeded profile: pristine (prompt === seeded_prompt) but
    // different from the current recipe definition.
    db.prepare("UPDATE staff_profiles SET system_prompt='OLD PROMPT', seeded_prompt='OLD PROMPT' WHERE id=?").run(profile.id);
    const resynced = staff.getProfileByRole('code_review', 'review_lead'); // triggers seedStaffProfiles()
    assert.match(resynced.system_prompt, /You are the Review Lead/);
    assert.equal(resynced.prompt_customized, false);
  });

  it('customized profiles are preserved by the drift sync', () => {
    const profile = staff.getProfileByRole('code_review', 'implementation_reviewer');
    db.prepare("UPDATE staff_profiles SET system_prompt='USER CUSTOM PROMPT' WHERE id=?").run(profile.id);
    const after2 = staff.getProfileByRole('code_review', 'implementation_reviewer');
    assert.equal(after2.system_prompt, 'USER CUSTOM PROMPT');
    assert.equal(after2.prompt_customized, true);
    // Restore the seeded prompt for other tests.
    staff.resetProfileToRecipe(profile.id, ['system_prompt']);
  });
});

describe('expanded recipe catalog — role metadata plumbing', () => {
  it('capability metadata drives coding-model choice in the model plan', () => {
    // llama3.1:70b outranks the coder overall, so general ≠ coding in this pool.
    const grouped = {
      ollama: [
        { id: 'qwen2.5-coder:14b', provider: 'ollama' },
        { id: 'llama3.1:70b', provider: 'ollama' },
      ],
    };
    const plan = colonyModels.proposeModelPlan(getColonyRecipe('refactor_migration'), grouped, { cloudEnabled: false });
    assert.equal(plan.refactor_engineer, 'qwen2.5-coder:14b', 'coding-capability role gets the coder model');
    assert.equal(plan.regression_qa, 'qwen2.5-coder:14b', 'QA role declares coding capability');
    assert.equal(plan.migration_planner, 'llama3.1:70b', 'planning role gets the general model');
    const bizPlan = colonyModels.proposeModelPlan(getColonyRecipe('business_strategy'), grouped, { cloudEnabled: false });
    for (const role of getColonyRecipe('business_strategy').roles) {
      assert.equal(bizPlan[role.key], bizPlan.operator, `business role ${role.key} uses the general model`);
    }
  });

  it('isCodingRoleKey respects capabilities metadata and falls back to the legacy set', () => {
    assert.equal(isCodingRoleKey('code_review', 'implementation_reviewer'), true);
    assert.equal(isCodingRoleKey('code_review', 'review_synthesizer'), false);
    assert.equal(isCodingRoleKey('go_to_market_launch', 'market_analyst'), false);
    assert.equal(isCodingRoleKey('incident_response', 'fix_engineer'), true);
    // Legacy fallback: no recipe context, dev-team role keys still count as coding.
    assert.equal(isCodingRoleKey(null, 'software_developer'), true);
    assert.equal(isCodingRoleKey(null, 'business_analyst'), false);
  });

  it('worker configs carry metadata that controls repo access, network, and guidelines', () => {
    const configs = buildRecipeWorkerConfigs(getColonyRecipe('security_review'), 'Audit the app', 'fake-model');
    const byKey = Object.fromEntries(configs.map(c => [c.role_key, c]));

    // Reviewers read the repo; the remediation engineer writes it with egress.
    assert.equal(workerRepoAccess(byKey.appsec_reviewer), 'read');
    assert.equal(workerNetwork(byKey.appsec_reviewer), null);
    assert.equal(workerRepoAccess(byKey.remediation_engineer), 'write');
    assert.equal(workerNetwork(byKey.remediation_engineer), 'bridge');
    assert.equal(workerIsCoding(byKey.remediation_engineer), true);
    // The analyst signoff role declares no coding capability → no guidelines.
    assert.equal(workerIsCoding(byKey.threat_modeler), false);
    assert.match(byKey.remediation_engineer.system_prompt, /Coding Guidelines|coding guidelines/i);
    assert.doesNotMatch(byKey.security_signoff.system_prompt, /\[Coding Guidelines\]/i);

    // Business roles: no repo, no network, no sandbox shell.
    const gtm = buildRecipeWorkerConfigs(getColonyRecipe('go_to_market_launch'), 'Launch it', 'fake-model');
    for (const wc of gtm) {
      assert.equal(workerRepoAccess(wc), null, `${wc.role_key} must not mount the repo`);
      assert.equal(workerNetwork(wc), null, `${wc.role_key} must not get sandbox egress`);
      assert.ok(!wc.tools.includes('sandbox'), `${wc.role_key} must not get the shell sandbox group`);
    }
  });

  it('legacy dev-team behavior is unchanged by the metadata fallbacks', () => {
    const configs = buildRecipeWorkerConfigs(getColonyRecipe('development_team'), 'Ship it', 'fake-model');
    const byKey = Object.fromEntries(configs.map(c => [c.role_key, c]));
    assert.equal(workerRepoAccess(byKey.software_developer), 'write');
    assert.equal(workerNetwork(byKey.software_developer), 'bridge');
    assert.equal(workerRepoAccess(byKey.project_manager), 'write'); // doc-writer fallback
    assert.equal(workerNetwork(byKey.project_manager), null);
    assert.equal(workerRepoAccess(byKey.business_analyst), null);
  });

  it('metadata drives MCP category attachment, with the legacy map as fallback', () => {
    const review = buildRecipeWorkerConfigs(getColonyRecipe('code_review'), 'Review', 'fake-model');
    const security = review.find(c => c.role_key === 'security_reviewer');
    assert.deepEqual(mcpCategoriesForWorker(security), ['code']);

    const discovery = buildRecipeWorkerConfigs(getColonyRecipe('product_discovery'), 'Discover', 'fake-model');
    const market = discovery.find(c => c.role_key === 'market_researcher');
    assert.deepEqual(mcpCategoriesForWorker(market), ['research']);
    const strategist = discovery.find(c => c.role_key === 'product_strategist');
    assert.deepEqual(mcpCategoriesForWorker(strategist), []);

    // Fallback path: a config with no metadata still resolves via the legacy map.
    assert.deepEqual(mcpCategoriesForWorker({ role_key: 'business_analyst' }), ['research']);
  });

  it('strict recipes give workers protocol tools; lightweight recipes do not', () => {
    for (const rid of STRICT_RECIPES) {
      for (const role of getColonyRecipe(rid).roles) {
        assert.ok(role.tools.includes('protocol_worker'), `${rid}/${role.key} needs the handoff tool group`);
      }
    }
    for (const rid of LIGHTWEIGHT_RECIPES) {
      for (const role of getColonyRecipe(rid).roles) {
        assert.ok(!role.tools.includes('protocol_worker'), `${rid}/${role.key} must not carry strict protocol tools`);
      }
    }
  });

  it('research_brief is a strict handoff flow: every role can hand off and the chain covers all roles', () => {
    const recipe = getColonyRecipe('research_brief');
    // Every worker needs the handoff tool group, or the operator-promised
    // handoff chain silently degrades to loose ask_agent delegation (the bug
    // where the Researcher's contribution was dropped from the deliverable).
    for (const role of recipe.roles) {
      assert.ok(role.tools.includes('protocol_worker'), `research_brief/${role.key} needs the handoff tool group`);
      assert.ok(role.tools.includes('protocol'), `research_brief/${role.key} needs the blackboard/protocol tool group`);
    }
    const flow = protocol.getFlow('research_brief');
    assert.ok(flow, 'research_brief must register a protocol flow');
    const roleKeys = new Set(recipe.roles.map(r => r.key));
    const flowKeys = new Set(flow.flatMap(e => [e.from, e.to]));
    for (const key of roleKeys) assert.ok(flowKeys.has(key), `research_brief role ${key} not part of the flow chain`);
    // The Researcher must be the entry point (no incoming edge).
    assert.ok(!flow.some(e => e.to === 'researcher'), 'researcher must be the first (source) role');
  });
});

describe('expanded recipe catalog — generic operator prompt', () => {
  function fakeWorkers(recipe) {
    return recipe.roles.map((r, i) => ({ id: `agent-${i}`, name: r.agent_name, persona_role: r.role, role_key: r.key }));
  }

  it('strict recipes get a flow-enforcing operator prompt with no create_agent path', () => {
    const recipe = getColonyRecipe('sales_enablement');
    const prompt = recipeOrchestratorPrompt('Sell the retainer', 'fake-model', recipe, fakeWorkers(recipe));
    assert.ok(prompt, 'seeded recipe must produce an operator prompt (not fall back to custom_auto)');
    assert.match(prompt, /Sales Enablement Team Operator/);
    assert.match(prompt, /preconditions are ENFORCED/);
    assert.match(prompt, /buyer_researcher → pitch_strategist/);
    assert.match(prompt, /Do not create agents/);
    assert.match(prompt, /Respond ONLY in English/);
    assert.doesNotMatch(prompt, /create_agent: spawn/);
  });

  it('lightweight recipes get a plan-driven operator prompt without protocol machinery', () => {
    const recipe = getColonyRecipe('hiring_pipeline');
    const prompt = recipeOrchestratorPrompt('Hire a consultant', 'fake-model', recipe, fakeWorkers(recipe));
    assert.ok(prompt);
    assert.match(prompt, /Hiring Pipeline Crew Operator/);
    assert.match(prompt, /Mission protocol/);
    assert.doesNotMatch(prompt, /Communication Protocol/);
    assert.doesNotMatch(prompt, /handoff\(\)/);
    assert.match(prompt, /Do not create agents/);
  });

  it('surfaces per-role artifact expectations to the operator', () => {
    const recipe = getColonyRecipe('go_to_market_launch');
    const prompt = recipeOrchestratorPrompt('Launch', 'fake-model', recipe, fakeWorkers(recipe));
    assert.match(prompt, /Expected artifacts/);
    assert.match(prompt, /launch_pm.*runbook/i);
  });

  it('existing development_team and research_brief prompts are untouched by the generic path', () => {
    const dev = getColonyRecipe('development_team');
    const devPrompt = recipeOrchestratorPrompt('Fix bug', 'fake-model', dev, fakeWorkers(dev));
    assert.match(devPrompt, /Hive Development Team Operator/);
    const research = getColonyRecipe('research_brief');
    const researchPrompt = recipeOrchestratorPrompt('Research', 'fake-model', research, fakeWorkers(research));
    assert.match(researchPrompt, /Hive Research Mission Operator/);
  });

  it('custom_auto still returns null (generic orchestrator path)', () => {
    assert.equal(recipeOrchestratorPrompt('Goal', 'fake-model', getColonyRecipe('custom_auto'), []), null);
  });
});

describe('expanded recipe catalog — recipe list sanity', () => {
  it('role keys are unique within every recipe', () => {
    for (const recipe of listColonyRecipes()) {
      const keys = recipe.roles.map(r => r.key);
      assert.equal(new Set(keys).size, keys.length, `${recipe.id} has duplicate role keys`);
    }
  });

  it('every role has a prompt, color, tools, and agent name', () => {
    for (const rid of Object.keys(EXPECTED_ROLE_COUNTS)) {
      for (const role of getColonyRecipe(rid).roles) {
        assert.ok(role.prompt && role.prompt.length > 100, `${rid}/${role.key} prompt too thin`);
        assert.match(role.color, /^#[0-9a-f]{6}$/i);
        assert.ok(role.tools.includes('memory'), `${rid}/${role.key} missing memory tool`);
        assert.ok(role.agent_name, `${rid}/${role.key} missing agent_name`);
      }
    }
  });
});

describe('expanded recipe catalog — staff personas and skills', () => {
  const { SKILL_SEEDS, SKILL_SEEDS_V2, SKILL_SEEDS_V3 } = require('../lib/skillSeeds');
  const catalogNames = new Set([...SKILL_SEEDS, ...SKILL_SEEDS_V2, ...SKILL_SEEDS_V3].map(s => s.name));
  // Founding recipes participate too: their roles carry v1-catalog skills.
  const ALL_SEEDED_RECIPES = [...Object.keys(EXPECTED_ROLE_COUNTS), 'development_team', 'research_brief'];

  it('every seeded role declares a personality and skill assignments', () => {
    for (const rid of Object.keys(EXPECTED_ROLE_COUNTS)) {
      for (const role of getColonyRecipe(rid).roles) {
        assert.ok(role.personality && role.personality.length > 40, `${rid}/${role.key} has no personality`);
        assert.ok(Array.isArray(role.skills) && role.skills.length >= 1, `${rid}/${role.key} has no skills`);
      }
    }
  });

  it('every skill referenced by any seeded role resolves to a skills-catalog entry', () => {
    for (const rid of ALL_SEEDED_RECIPES) {
      for (const role of getColonyRecipe(rid).roles) {
        for (const skill of role.skills || []) {
          assert.ok(catalogNames.has(skill), `${rid}/${role.key} references unknown skill "${skill}"`);
        }
      }
    }
  });

  it('skill names are unique across both catalog batches and seeded into the DB', () => {
    const all = [...SKILL_SEEDS, ...SKILL_SEEDS_V2, ...SKILL_SEEDS_V3].map(s => s.name);
    assert.equal(new Set(all).size, all.length, 'duplicate skill name across seed batches');
    const inDb = db.prepare('SELECT COUNT(*) AS n FROM skills WHERE name IN (?, ?, ?)').get('Market Research', 'Funnel Analysis', 'SOP Writing');
    assert.equal(inDb.n, 3, 'v2 skills must be seeded into the skills table');
  });

  it('seeded profiles carry the personality and skills; stale profiles are backfilled once', () => {
    const fresh = staff.getProfileByRole('sales_enablement', 'objection_handler');
    assert.match(fresh.personality, /objections/i);
    assert.deepEqual(fresh.skills, ['Objection Handling']);

    // Simulate a profile seeded before personas existed (empty personality,
    // title-only skills) and re-arm the one-time backfill flag.
    db.prepare("UPDATE staff_profiles SET personality='', skills=json_array(role) WHERE recipe_id='sales_enablement' AND role_key='objection_handler'").run();
    db.prepare("DELETE FROM app_settings WHERE key='staff_personas_seeded_v2'").run();
    const backfilled = staff.getProfileByRole('sales_enablement', 'objection_handler');
    assert.match(backfilled.personality, /objections/i);
    assert.deepEqual(backfilled.skills, ['Objection Handling']);

    // A deliberately cleared personality stays cleared (flag consumed).
    db.prepare("UPDATE staff_profiles SET personality='' WHERE recipe_id='sales_enablement' AND role_key='objection_handler'").run();
    const cleared = staff.getProfileByRole('sales_enablement', 'objection_handler');
    assert.equal(cleared.personality, '');
    // Restore for other tests.
    db.prepare("DELETE FROM app_settings WHERE key='staff_personas_seeded_v2'").run();
    staff.listProfiles();
  });
});
