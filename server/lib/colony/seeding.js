// Recipe worker seeding.
// Recipe-driven colonies create a known roster before the operator starts, so
// the orchestrator delegates to fixed agent IDs instead of inventing worker
// roles/prompts at runtime. This module builds worker configs (staffing,
// per-role models, repo guidelines, sandbox preflight, MCP attachment), writes
// the agents, and links them to the colony.
const { writeAgent, stripProviderPrefix } = require('../agentParser');
const { readRepoGuidelines } = require('../codingGuidelines');
const colonyModels = require('../colonyModels');
const staffDirectory = require('../staffDirectory');
const sandbox = require('../sandbox');
const db = require('../../db');
const { logSwallowed } = require('../logSwallowed');
const { buildRecipeWorkerConfigs, recipeOrchestratorPrompt, isCustomAutoRecipe } = require('../colonyRecipes');
const { addAgentToColony } = require('./persistence');
const { connectedMcpServers, mcpCategoriesForWorker } = require('./mcp');
const { orchestratorPrompt } = require('./prompts');

// ── Role-metadata seeding decisions ───────────────────────────────────────────
// Worker configs carry `_role_meta` (capabilities, repo_access, network, mcp)
// from the recipe definition. These helpers turn that metadata into concrete
// seeding decisions, with legacy role-key fallbacks for configs that predate
// metadata (custom staff profiles, hand-rolled configs in tests).

function workerIsCoding(workerConfig) {
  return colonyModels.isCodingRole({
    key: workerConfig.role_key,
    capabilities: workerConfig._role_meta?.capabilities || undefined,
  });
}

// Legacy fallback: the PM and designer write record-keeping/spec artifacts
// under docs/, so they get a writable mount too (file tools only, no shell).
const DOC_WRITER_ROLES = new Set(['project_manager', 'ui_ux_designer']);

// 'write' | 'read' | null — how (and whether) to mount the colony repo.
function workerRepoAccess(workerConfig) {
  const declared = workerConfig._role_meta?.repo_access;
  if (declared === 'write' || declared === 'read') return declared;
  if (declared === null && workerConfig._role_meta?.capabilities) {
    // Metadata-bearing role that explicitly declares no repo access.
    return null;
  }
  if (workerIsCoding(workerConfig) || DOC_WRITER_ROLES.has(workerConfig.role_key)) return 'write';
  return null;
}

// 'bridge' | null — sandbox egress (installs need the network; default stays none).
function workerNetwork(workerConfig) {
  const declared = workerConfig._role_meta?.network;
  if (declared === 'bridge') return 'bridge';
  if (declared === null && workerConfig._role_meta?.capabilities) return null;
  return workerIsCoding(workerConfig) ? 'bridge' : null;
}

// Seed the recipe's workers into the DB and populate the run-scoped
// `recipeWorkers` array + `reasoningByAgentId` map (both mutated in place).
// `ctx` carries all run inputs:
//   { colonyId, row, recipe, modelPlan, teamRow, memorySection,
//     reasoningDecision, workerReasoningDefault, reasoningByAgentId,
//     recipeWorkers, addEntry }
function seedRecipeWorkers(ctx) {
  const {
    colonyId, row, recipe, modelPlan, teamRow, memorySection,
    reasoningDecision, workerReasoningDefault, reasoningByAgentId,
    recipeWorkers, addEntry,
  } = ctx;

  const mcpServers = connectedMcpServers();
  const researchServers = mcpServers.filter(s => s.categories.includes('research'));
  const codeServers = mcpServers.filter(s => s.categories.includes('code'));
  if (researchServers.length || codeServers.length) {
    addEntry({
      kind: 'recipe',
      recipe_id: recipe.id,
      message: `Connected MCP tools available — research: ${researchServers.map(s => s.name).join(', ') || 'none'}; code/repo: ${codeServers.map(s => s.name).join(', ') || 'none'}. Attaching to roles by need.`,
    });
  } else {
    addEntry({
      kind: 'recipe',
      recipe_id: recipe.id,
      message: 'No connected MCP tools available for this recipe; workers will use built-in tools and caveated fallback.',
    });
  }
  let workerConfigs = buildRecipeWorkerConfigs(recipe, row.goal, row.model, modelPlan);
  // Operator staffing: pick the best staff member for each preset role
  // based on the colony's requirements (team name/description + mission).
  const staffingRequirements = [teamRow?.name, teamRow?.description, row.goal].filter(Boolean).join(' ');
  const staffSelections = [];
  workerConfigs = staffDirectory.applyStaffProfilesToWorkerConfigs(recipe.id, workerConfigs, modelPlan, {
    requirements: staffingRequirements,
    onSelect: s => staffSelections.push(s),
  });
  if (staffSelections.length) {
    addEntry({
      kind: 'recipe',
      recipe_id: recipe.id,
      message: `Operator staffing: ${staffSelections.map(s => `${s.role_key} → ${s.display_name}${s.candidates > 1 ? ` (picked from ${s.candidates}: ${s.reason})` : ''}`).join('; ')}`,
    });
  }
  const planned = workerConfigs.filter(w => w.model && w.model !== row.model);
  if (planned.length) {
    addEntry({ kind: 'recipe', recipe_id: recipe.id, message: `Per-role models: ${workerConfigs.map(w => `${w.role_key}=${stripProviderPrefix(w.model)}`).join(', ')}` });
  }
  // Honor the target repo's own coding guidelines (AGENTS.md/CONTRIBUTING.md)
  // for coding roles — prepended as authoritative over the built-in defaults.
  const repoGuidelines = row.repo_path ? readRepoGuidelines(row.repo_path) : '';
  if (repoGuidelines) {
    for (const wc of workerConfigs) {
      if (workerIsCoding(wc)) wc.system_prompt += repoGuidelines;
    }
    addEntry({ kind: 'recipe', recipe_id: recipe.id, message: 'Loaded repository coding guidelines for coding roles.' });
  }
  // Sandbox capability preflight — tell the user up front whether real coding
  // is possible when this crew has coding roles and a repo to work in. If not,
  // remove the sandbox tool before workers are written so they do not loop on
  // an unavailable runtime.
  const hasCodingRole = recipe.roles.some(r => colonyModels.isCodingRole(r));
  if (hasCodingRole && row.repo_path) {
    try {
      const cap = sandbox.capabilities();
      addEntry({ kind: cap.ready ? 'recipe' : 'preflight', recipe_id: recipe.id, message: `Sandbox: ${cap.message}` });
      if (!cap.ready) {
        for (const wc of workerConfigs) {
          if (workerIsCoding(wc)) {
            wc.tools = (wc.tools || []).filter(tool => tool !== 'sandbox');
            wc.system_prompt += `\n\n[Sandbox unavailable]\n${cap.message}\nDo not attempt code edits or test execution in this run. Report the capability blocker clearly and hand off only planning or review work that can be done without executing code.`;
          }
        }
      }
    } catch (e) { logSwallowed('colonyRunner:sandboxCapabilities', e, { colonyId }); }
  }
  const protocolDiscipline = `

[Protocol discipline]
Do your role's ACTUAL work first — protocol tools are bookkeeping, not work.
Per turn: at most ONE blackboard_read, ONE blackboard_write (a single consolidated
update), and ONE checkpoint at the very end. Re-posting the same status is failure,
not progress. NEVER end your turn silently: finish with handoff() when your work is
complete, or a plain-text answer stating exactly what you did and what remains.`;
  for (const workerConfig of workerConfigs) {
    workerConfig.system_prompt += protocolDiscipline;
    if (memorySection) workerConfig.system_prompt += memorySection;
    const wantCats = mcpCategoriesForWorker(workerConfig);
    const matched = mcpServers.filter(s => s.categories.some(c => wantCats.includes(c)));
    if (matched.length > 0) {
      const usesResearch = wantCats.includes('research') && matched.some(s => s.categories.includes('research'));
      // When live research MCP is attached, drop the built-in web_search so the
      // worker uses one consistent surface. Code MCP is additive to sandbox.
      const baseTools = (workerConfig.tools || []).filter(tool => !(usesResearch && tool === 'web_search'));
      workerConfig.tools = [...new Set([...baseTools, ...matched.map(s => s.group)])];
      if (usesResearch) {
        workerConfig.system_prompt += `\n\n[MCP Tools]\nUse the connected MCP tools for live web or document access. When both search and fetch tools are available, use search for topic discovery and fetch for known URLs. The built-in Ollama web_search endpoint is not enabled for this worker when MCP tools are available, so do not refer to it or try to call it. Tool errors, rate limits, and throttling are not evidence that no sources exist; report them as live-access failures and list the verification gap.`;
      } else {
        const pathHint = row.repo_path
          ? ` Filesystem tool paths must be ABSOLUTE under the repository root ${row.repo_path} (e.g. ${row.repo_path}/package.json) — relative paths resolve outside the allowed directory and are denied.`
          : '';
        workerConfig.system_prompt += `\n\n[MCP Tools]\nYou have connected MCP tools for repository/code access (${matched.map(s => s.name).join(', ')}). Prefer them for reading code, issues, PRs, and files over guessing.${pathHint} Report tool errors as access failures rather than assuming nothing exists.`;
      }
    }
    const worker = writeAgent(null, workerConfig);
    addAgentToColony(colonyId, worker.id);
    // Link the staff profile to its freshly seeded worker agent.
    if (workerConfig.role_key) {
      try { staffDirectory.linkAssignedAgent(recipe.id, workerConfig.role_key, worker.id, workerConfig._staff_profile_id); } catch (e) { logSwallowed('colonyRunner:linkStaff', e, { agentId: worker.id }); }
    }
    // Role metadata decides the repo mount: 'write' roles edit the real
    // project (coding, doc-writing), 'read' roles inspect it (reviewers,
    // analysts), everyone else gets no mount at all.
    const repoAccess = workerRepoAccess(workerConfig);
    if (row.repo_path && repoAccess) {
      try { sandbox.setAgentRepo(worker.id, row.repo_path, { writable: repoAccess === 'write' }); } catch (e) { logSwallowed('colonyRunner:setAgentRepo', e, { agentId: worker.id }); }
    }
    // Sandbox egress: the default is network=none; roles that install
    // dependencies or audit registries declare network 'bridge' in metadata
    // (coding roles get it by legacy fallback).
    if (workerNetwork(workerConfig) === 'bridge') {
      try { sandbox.setAgentNetwork(worker.id, 'bridge'); } catch (e) { logSwallowed('colonyRunner:setAgentNetwork', e, { agentId: worker.id }); }
    }
    const roleReasoning = workerConfig.role_key && Object.prototype.hasOwnProperty.call(reasoningDecision.by_role, workerConfig.role_key)
      ? reasoningDecision.by_role[workerConfig.role_key]
      : workerReasoningDefault;
    recipeWorkers.push({
      id: worker.id,
      name: worker.name,
      persona_role: worker.persona_role,
      avatar_color: worker.avatar_color,
      model: worker.model,
      tools: worker.tools,
      role_key: workerConfig.role_key || null,
      reasoning: roleReasoning,
    });
    reasoningByAgentId.set(worker.id, roleReasoning);
  }
}

// Create the colony orchestrator agent, persist it, and emit its agent_ready
// events (plus one per seeded worker). Generic (custom-auto) orchestrators get
// broad agent tools so they can create workers; recipe operators get only
// colony control + delegation since their roster is already fixed.
// `ctx` = { colonyId, row, recipe, recipeWorkers, operatorModel, memorySection,
//           reasoningByAgentId, addEntry, onEvent }. Returns the orch agent.
function createOrchestrator(ctx) {
  const {
    colonyId, row, recipe, recipeWorkers, operatorModel, memorySection,
    reasoningByAgentId, addEntry, onEvent,
  } = ctx;

  const recipePrompt = recipeOrchestratorPrompt(row.goal, operatorModel, recipe, recipeWorkers, { githubWriteback: !!row.github_writeback });
  const orchestratorTools = isCustomAutoRecipe(recipe.id)
    ? ['colony_tools', 'agent_tools', 'sandbox', 'memory', 'protocol']
    : ['colony_tools', 'delegation', 'protocol'];
  const orch = writeAgent(null, {
    name:         'Ari Morgan',
    persona_role: isCustomAutoRecipe(recipe.id) ? 'Colony Orchestrator' : `${recipe.name} Operator`,
    model:        operatorModel,
    avatar_color: '#f59e0b',
    tools:        orchestratorTools,
    system_prompt: (recipePrompt || orchestratorPrompt(row.goal, operatorModel)) + memorySection,
    temperature:  0.4,
    max_tokens:   8192,
    context_length: 32768,
    ephemeral:    true,
  });

  db.prepare('UPDATE colonies SET orchestrator_id=?, updated_at=unixepoch() WHERE id=?')
    .run(orch.id, colonyId);
  addAgentToColony(colonyId, orch.id);
  reasoningByAgentId.set(orch.id, true);

  const orchAgent = { id: orch.id, name: orch.name, persona_role: orch.persona_role, avatar_color: orch.avatar_color, model: orch.model, tools: orch.tools };
  onEvent({ type: 'agent_ready', role: 'orchestrator', agent: orchAgent });
  addEntry({ kind: 'agent_ready', role: 'orchestrator', agent: orchAgent });

  for (const worker of recipeWorkers) {
    onEvent({ type: 'agent_ready', role: 'worker', agent: worker });
    addEntry({ kind: 'agent_ready', role: 'worker', agent: worker });
  }

  return orch;
}

module.exports = {
  seedRecipeWorkers,
  createOrchestrator,
  // Exported for tests: pure metadata → seeding-decision helpers.
  workerIsCoding,
  workerRepoAccess,
  workerNetwork,
};
