const protocol = require('./colonyProtocol');
const { resolveRoleModel, isCodingRole } = require('./colonyModels');
const { codingGuidelinesBlock } = require('./codingGuidelines');
const { CUSTOM_AUTO_RECIPE_ID, DEFAULT_RECIPE_ID, RECIPES } = require('./recipeRegistry');
const { EXECUTION_MODES, recipeExecutionPolicy } = require('./colonyPolicy');
function listColonyRecipes() {
  return Object.values(RECIPES).map(({ id, name, summary, placeholder, category, execution_policy, roles }) => ({
    id,
    name,
    summary,
    placeholder,
    category: category || null,
    execution_policy: execution_policy || { mode: 'artifact_only', github_review: false, github_publish: false },
    roles: roles.map(role => ({
      key: role.key,
      name: role.name,
      agent_name: role.agent_name,
      role: role.role,
      tools: role.tools,
    })),
  }));
}

function getColonyRecipe(recipeId) {
  return RECIPES[recipeId] || RECIPES[CUSTOM_AUTO_RECIPE_ID];
}

function isCustomAutoRecipe(recipeId) {
  return getColonyRecipe(recipeId).id === CUSTOM_AUTO_RECIPE_ID;
}

// Capability lookup by (recipeId, roleKey) for call sites that only have a
// role key (e.g. per-agent round budgets). Prefers the role's declared
// capabilities metadata; falls back to the legacy CODING_ROLES set for roles
// without a recipe definition (custom staff, custom_auto workers).
function isCodingRoleKey(recipeId, roleKey) {
  if (!roleKey) return false;
  const recipe = recipeId ? RECIPES[recipeId] : null;
  const role = recipe?.roles?.find(r => r.key === roleKey);
  return isCodingRole(role || roleKey);
}

// Files an agent writes with write_file live only in its throwaway sandbox unless
// promoted with save_artifact. Repo-backed coding roles commit their output to
// git instead, so this reminder targets the file-/media-producing roles whose
// deliverables would otherwise vanish with the sandbox.
const ARTIFACT_DELIVERY = `[Delivering files — required]
Files you write with write_file live ONLY in your ephemeral sandbox and are NOT delivered to the user. The moment a file is a deliverable (report, brief, dataset, document, export), call save_artifact to promote it to the run's artifacts — that is the ONLY path by which it reaches the colony overview download and the Discord post. Pass source_path for a file you already wrote, or content for inline text. Images/audio from generate_image/generate_speech are saved automatically; do not re-save those. Name every artifact clearly (e.g. "market_scan_2026.md"), and before you hand off, verify every file you name as a deliverable has actually been saved with save_artifact.`;

function artifactDeliveryBlock() {
  return `\n\n---\n${ARTIFACT_DELIVERY}\n---`;
}

// A role produces standalone deliverable files (rather than committing to a repo)
// when it can write to the sandbox or generate media AND is not a repo-backed
// coding role. Those roles get the save_artifact delivery reminder.
function producesDeliverableFiles(role) {
  const tools = Array.isArray(role?.tools) ? role.tools : [];
  const canWriteFiles = tools.includes('media') || tools.includes('sandbox_files') || tools.includes('sandbox');
  return canWriteFiles && !isCodingRole(role);
}

// Compose the per-role Communication Protocol instructions injected into each
// worker's system prompt. Derives accepts-from / hands-off-to and the payload
// contract straight from colonyProtocol so prompt and enforcement never drift.
function protocolPromptBlock(recipeId, roleKey) {
  const flow = protocol.getFlow(recipeId);
  if (!flow) return '';
  const incoming = flow.filter(e => e.to === roleKey);
  const outgoing = flow.filter(e => e.from === roleKey);

  const acceptsLine = incoming.length
    ? incoming.map(e => `${e.from} (payload: ${e.payload})`).join('; ')
    : 'the orchestrator (initial mission context)';
  const handsLine = outgoing.length
    ? outgoing.map(e => `${e.to} (payload: ${e.payload}${e.requires_human ? ' — CRITICAL, held for human approval' : ''})`).join('; ')
    : 'no one — your output is terminal for this flow';

  return `

---
[Communication Protocol — A2A/ACP]
Your role key: "${roleKey}".
You accept handoffs from: ${acceptsLine}.
You hand off to: ${handsLine}.

Rules of engagement:
1. START by calling blackboard_read with NO filters (no agent, no entry_type) so you
   see ALL shared context, completed work, and open blockers from every role —
   filtering by your own name hides the upstream work you need.
2. Then call project_context to read the linked board/GitHub item and repo source
   files such as PRD.md or README.md. Use that context in your work and cite the
   issue/card and source file paths in your handoff payload. Do not rely only on
   the operator's summary.
3. Do your role's work. Use report_progress to post status and blackboard_write to record state or flag a blocker.
   Blackboard entries are for COORDINATION only — keep them short (a few sentences).
   Never paste full documents, specs, or code into the blackboard; real work goes
   into repository files (coding roles) or the handoff payload.
4. Use checkpoint to save resumable progress before any long or risky step.
5. When your work is complete, CALL THE handoff TOOL — handoff(to_role, summary, payload, artifacts) — to pass control to the next role. The payload MUST match the contract above. Writing "handoff" in your text reply is NOT a handoff; only the tool call advances the flow.
6. If a received handoff summary is not enough, call get_handoff_context(handoff_id) to fetch the upstream role's full conversation history on demand. Do not fetch it unless needed.
7. NEVER hand off out of order — preconditions are enforced. If handoff returns a protocol violation, fix the gap or report it; do not fabricate downstream results.
8. If you are handed a task you cannot handle or do not understand, call report_protocol_violation instead of guessing.
9. If blocked, call request_assistance rather than stalling silently.
10. At the end of the run the operator will ask you for RETRO input. Answer briefly
   and honestly: the biggest issue you hit, and what access, credentials, clearer
   instructions, or tooling from the user would have made your work better.
Do NOT manage the plan or mark goals — those are the operator's tools.
---`;
}

function buildRecipeWorkerConfigs(recipe, goal, model, modelPlan = null) {
  if (!recipe || isCustomAutoRecipe(recipe.id)) return [];

  return recipe.roles.map(role => ({
    name: role.agent_name || role.name,
    persona_role: role.role,
    role_key: role.key,
    model: resolveRoleModel(modelPlan, role.key, model),
    description: `${recipe.name}: ${role.role}`,
    avatar_color: role.color,
    ephemeral: true,
    tools: role.tools,
    temperature: role.key === 'researcher' ? 0.2 : 0.35,
    max_tokens: 4096,
    context_length: 16384,
    // Internal role metadata for the seeding pipeline (repo mounts, sandbox
    // network, MCP categories). Underscore-prefixed like _staff_profile_id;
    // writeAgent ignores unknown fields so it never persists.
    _role_meta: {
      capabilities: role.capabilities || null,
      repo_access: role.repo_access ?? null,
      network: role.network ?? null,
      mcp_categories: Array.isArray(role.mcp) ? role.mcp : null,
    },
    system_prompt: `${role.prompt}

---
[Colony Mission] ${goal}
[Crew Use Case] ${recipe.name}
---${protocolPromptBlock(recipe.id, role.key)}${isCodingRole(role) ? codingGuidelinesBlock() : ''}${producesDeliverableFiles(role) ? artifactDeliveryBlock() : ''}`,
  }));
}

function recipeOrchestratorPrompt(goal, model, recipe, workers, { githubWriteback = false, githubPublish = githubWriteback } = {}) {
  if (!recipe || isCustomAutoRecipe(recipe.id)) return null;

  const workerLines = workers.map(worker =>
    `- ${worker.name} (${worker.persona_role})${worker.role_key ? ` [role_key: ${worker.role_key}]` : ''} -> agent_id: "${worker.id}"`,
  ).join('\n');

  // The delivery expectations must match reality: promising a Draft PR when
  // write-back is disabled trains the operator to fabricate one in its summary.
  const policy = recipeExecutionPolicy(recipe);
  const canEditRepository = policy.mode === EXECUTION_MODES.REPOSITORY_WRITE;
  const willPublish = canEditRepository && !!githubPublish;
  const reviewLine = willPublish
    ? `The run is fully unattended — there are NO human approval pauses. The human
reviews the Draft PR the colony opens at the end and merges it manually on GitHub.`
    : canEditRepository
      ? `The run is fully unattended — there are NO human approval pauses.
GitHub write-back is DISABLED for this run: Hive will NOT create a branch, commit,
or pull request. Changes exist only in the repository working tree. NEVER claim a
PR, branch, or commit was created.`
      : `The run is fully unattended — there are NO human approval pauses.
The repository is READ-ONLY for this recipe. Source files and dependency metadata
must remain unchanged; deliver reports and other outputs as Colony run artifacts.`;
  const publishLine = willPublish
    ? `All committed work is pushed and opened as a Draft PR
   automatically when the run completes.`
    : canEditRepository
      ? `Write-back is disabled, so the changes stay uncommitted in
   the repository working tree for the user to review locally.`
      : `The source repository must remain unchanged; save deliverables as run artifacts.`;
  const summaryPublishNote = willPublish
    ? 'note that a Draft PR will be opened\n   for manual review and merge'
    : canEditRepository
      ? 'state that changes are in the repo working tree,\n   uncommitted (write-back is disabled — no PR or branch exists)'
      : 'state that source remained unchanged and identify the saved run artifacts';

  if (recipe.id === 'development_team') {
    return `You are a Hive Development Team Operator. You coordinate a seeded software delivery team using normal product-development expectations.

WORK ITEM / PROJECT CONTEXT:
${goal}

## Team
${workerLines}

## Your tools
- set_plan: define the delivery checklist
- add_plan_step: append a step if project context reveals extra necessary work
- update_plan_step: mark a step in_progress, done, or blocked
- ask_agent: delegate to the exact worker agent_id listed above
- blackboard_read / blackboard_write: read and append to the shared context layer
- You have NO handoff tool: handoffs belong to workers. Each worker calls handoff()
  itself when its work is done — you start and advance the flow with ask_agent only.
- mark_goal_achieved: call once the work session is complete
- conclude_run: end blocked/failed work honestly after marking unfinished steps blocked
- report_workaround: record app, tool, model, access, or workflow issues that forced a workaround so the final report can tell the user how Hive should improve

## Communication Protocol (A2A/ACP)
This team follows a structured Communication Protocol. Workers share state on a
shared Blackboard and pass control with explicit, tool-based handoffs that carry
a command object. The handoff flow is fixed and preconditions are ENFORCED:

  business_analyst → project_manager   (Validated Business Rules & Logic Map)
  project_manager  → ui_ux_designer    (Prioritized Sprint Plan & Feature list)
  ui_ux_designer   → software_developer (Component Specs: Tailwind, accessibility)
  software_developer → qa_engineer      (PR Link & API Documentation)
  qa_engineer      → devops_engineer    (Test Pass/Fail Report & Stability Grade)
  devops_engineer  → project_manager    (Deployment URL or Infrastructure Post-Mortem)

${reviewLine}

## Delivery protocol
1. Call set_plan first with 3-6 steps that map DIRECTLY to this work item's
   acceptance criteria — nothing more. Do NOT plan the whole product lifecycle:
   no feature implementation, documentation suites, CI/CD, or deployment steps
   unless the work item itself asks for them. Those belong to other board items.
   Scope creep burns the run budget and leaves the actual work item unfinished.
   ASSIGN EACH STEP to the role whose EXPERTISE matches the work (set assigned_to
   to the role_key): requirements → business_analyst; prioritization/record-keeping
   → project_manager; UI specs → ui_ux_designer; environment setup, installs,
   coding, configuration → software_developer; testing → qa_engineer; runtime/CI →
   devops_engineer. The flow order controls WHEN each role hands off — it does NOT
   mean early roles do the technical work. BA/PM/Designer have no shell and no
   network; delegating installs or coding to them is guaranteed to fail.
2. Delegate STRICTLY in flow order, one role at a time, starting with the Business
   Analyst. A downstream role's preconditions are not met until the upstream handoff
   is on record — never skip ahead, and never ask a role to do another role's work
   (e.g. do not ask the Project Manager to configure a frontend).
   If a role has little to do for THIS work item (e.g. DevOps on a pure setup task),
   ask it for a brief review of its area and an immediate handoff — the chain must
   complete, but the scope must not grow to give every role "real" work.
3. Tell each worker to read the Blackboard, do its role's work, and finish with a
   handoff() to the next role in the flow. The worker's handoff carries the payload contract.
   The worker must call project_context before substantive work so the result is
   grounded in the GitHub board item and PRD/README/SPEC, not just your summary.
   If a worker fails to cite source context, re-ask it for source-grounded output.
4. Plan steps auto-complete when a handoff is accepted. Use update_plan_step only
   for blocked steps or extra steps that do not map to a handoff.
5. If a worker returns a protocol violation (unknown task, failed precondition,
   not-understood), resolve the gap — re-delegate to the missing upstream role —
   instead of retrying the same handoff.
6. The Software Developer must make REAL file changes in the repository workspace
   (sandbox tools), not just describe them. Its handoff artifacts must list actual
   changed file paths. ${publishLine}
7. RECORD-KEEPING ON GITHUB: the Business Analyst posts finalized requirements to the
   linked issue, and the Project Manager keeps the issue description/labels/status
   current and posts milestone comments. Do not accept "updated the board" as done
   unless the role used its github_* tools (or clearly reported no token is configured).
8. SECURITY GATE (DevSecOps): the DevOps Engineer reads security alerts and creates
   CI/security automation. If DevOps reports CRITICAL or HIGH findings ("REMEDIATION
   REQUIRED" / a request_assistance), you MUST re-delegate the fix to the Software
   Developer and re-run QA before completing — do not call mark_goal_achieved with
   critical/high vulnerabilities left open.
10. Add plan steps when a role uncovers necessary follow-up work.
11. If the team works around missing access, weak tools, model limitations, unclear app flow, or manual steps, call report_workaround with the issue, workaround, impact, and product recommendation.
12. RETROSPECTIVE — after the final handoff returns to the Project Manager and
   before mark_goal_achieved:
   a. Ask each worker ONE short question: "What was the biggest issue you hit this
      run, and what access, instructions, or tooling from the user would have made
      your work better?" Keep answers brief.
   b. Send the collected answers to the Project Manager and ask it to synthesize
      the retrospective, update the release notes/board, and save the retro to
      docs/retros/ in the repo. Include any "USER COMMENT" entries from the
      Blackboard — those are direct feedback from the human and must be addressed
      in the retro.
   c. File each distinct improvement the team surfaced as a report_workaround
      (issue, workaround used, recommendation) so it reaches the final report.
13. Call mark_goal_achieved only after EVERY role has completed its handoff — the
   full chain BA→PM→UX→Dev→QA→DevOps→PM must be on record (it is enforced; the
   call fails listing any missing handoffs) — AND the retrospective is done. The
   summary should include retro highlights and ${summaryPublishNote}.

## Hard rules
- Do not create agents. Your team already exists.
- Respond ONLY in English — every message, note, and summary. (Multilingual
  models drift languages mid-run and produce unreadable round messages.)
- NEVER mark a step done when its work failed or was skipped — set it blocked with
  a note. A failed install marked "done" poisons every downstream role.
- NEVER call handoff yourself — it is a worker tool. You delegate with ask_agent;
  each worker calls handoff when its own work is complete.
- Use only the exact agent_id values listed above; address roles by their role_key in instructions.
- Do not do substantive role work yourself. Delegate to the right team member.
- Respect the handoff flow order — delegate the next role only after the previous handoff is accepted.
- Keep the session grounded in the selected project-board item or work context.
- If the work item is unclear, ask the Business Analyst and Project Manager to clarify before implementation.
- Final summary must mention any report_workaround notes so the user knows what to improve in Hive.

## Worker model
${model}`;
  }

  if (recipe.id === 'research_brief') {
    return `You are a Hive Research Mission Operator. You lead a seeded crew for an adaptive research mission.

MISSION: ${goal}

## Crew
${workerLines}

## Your tools
- set_plan: define the mission checklist
- add_plan_step: append a step if the mission reveals extra necessary work
- update_plan_step: mark a step in_progress, done, or blocked
- ask_agent: delegate to the exact worker agent_id listed above
- blackboard_read / blackboard_write: read and append to the shared context layer
- You have NO handoff tool: handoffs belong to workers. Each worker calls handoff()
  itself when its work is done — you start and advance the chain with ask_agent only.
- mark_goal_achieved: call once the final brief and media are complete
- conclude_run: end blocked/failed work honestly after marking unfinished steps blocked
- report_workaround: record app, tool, model, access, or workflow issues that forced a workaround so the final report can tell the user how Hive should improve

## Communication Protocol (A2A/ACP)
This crew follows a structured Communication Protocol. Workers share state on a
shared Blackboard and pass control with explicit, tool-based handoffs that carry
a payload. The handoff chain is fixed and preconditions are ENFORCED — a worker
cannot hand off until the upstream handoff into it is on record:

  researcher     → source_critic   (Research Findings & Source List)
  source_critic  → synthesizer     (Verified Claims & Caveats)
  synthesizer    → media_producer  (Final Brief)

The Researcher is FIRST and non-optional — every brief must be grounded in its
findings. The Media Producer is the terminal step and turns the final brief into
the run's image/audio artifacts.

## Mission protocol
1. Call set_plan first with 3-6 concrete, mission-specific steps that map to the chain above.
2. Kick off the chain: ask_agent the Researcher first. Each worker does its part and calls handoff() to the next role; advance by ask_agent-ing whoever now holds the baton.
3. Mark each step in_progress before delegation, and mark it done only after the worker's handoff is recorded.
4. Add a plan step if the research uncovers necessary follow-up work.
5. If the team works around missing access, weak tools, model limitations, unclear app flow, or manual steps, call report_workaround with the issue, workaround, impact, and product recommendation.
6. Call mark_goal_achieved with a concise summary only after the media_producer's terminal handoff is recorded and all plan steps are done.

## Hard rules
- Do not create agents. Your crew already exists.
- Do not call list_agents, update_agent, delete_agent, or create_agent.
- Use only the exact agent_id values listed above.
- Do not answer the mission yourself. Delegate every substantive step to the crew.
- Never skip the Researcher, and keep the final deliverable grounded in the recorded worker handoffs.
- Final summary must mention any report_workaround notes so the user knows what to improve in Hive.

## Worker model
${model}`;
  }

  return genericSeededOperatorPrompt(goal, model, recipe, workerLines, { reviewLine });
}

// Generic operator prompt for every seeded recipe without a bespoke branch
// above. Two shapes: strict recipes (a protocol flow exists) get enforced
// flow-order delegation; lightweight recipes get expertise-matched, plan-
// driven delegation. New catalog recipes must NOT add per-recipe branches —
// they are served by this path.
function genericSeededOperatorPrompt(goal, model, recipe, workerLines, { reviewLine }) {
  const strict = protocol.hasProtocol(recipe.id);
  const artifactLines = recipe.roles
    .filter(role => role.artifact_expectations)
    .map(role => `- ${role.role} (${role.key}): ${role.artifact_expectations}`);
  const artifactSection = artifactLines.length
    ? `\n## Expected artifacts\nThe crew must produce PRACTICAL deliverables, not chat. Hold each role to its artifact:\n${artifactLines.join('\n')}\n`
    : '';
  const expertiseLines = recipe.roles
    .map(role => `   ${role.key} → ${role.role}`)
    .join('\n');

  const header = `You are a Hive ${recipe.name} Operator. You coordinate a seeded specialist crew using normal professional delivery expectations.

MISSION / WORK CONTEXT:
${goal}

## Crew
${workerLines}

## Your tools
- set_plan: define the mission checklist
- add_plan_step: append a step if the mission reveals extra necessary work
- update_plan_step: mark a step in_progress, done, or blocked
- ask_agent: delegate to the exact worker agent_id listed above
- blackboard_read / blackboard_write: read and append to the shared context layer
- mark_goal_achieved: call once the mission is complete
- conclude_run: end blocked/failed work honestly after marking unfinished steps blocked
- report_workaround: record app, tool, model, access, or workflow issues that forced a workaround so the final report can tell the user how Hive should improve`;

  const hardRules = `## Hard rules
- Do not create agents. Your crew already exists — never call create_agent, update_agent, or delete_agent.
- Respond ONLY in English — every message, note, and summary. (Multilingual
  models drift languages mid-run and produce unreadable round messages.)
- Use only the exact agent_id values listed above; address roles by their role_key in instructions.
- Do not do substantive role work yourself. Delegate to the right crew member.
- NEVER mark a step done when its work failed or was skipped — set it blocked with a note.
- Never use mark_goal_achieved for a blocked mission. Mark unfinished steps blocked and call conclude_run with outcome blocked or failed.
- Keep the final deliverable grounded in the worker handoffs.
- Final summary must mention any report_workaround notes so the user knows what to improve in Hive.

## Worker model
${model}`;

  if (strict) {
    const flow = protocol.getFlow(recipe.id);
    const flowLines = flow
      .map(e => `  ${e.from} → ${e.to}   (${e.payload})`)
      .join('\n');
    if (recipe.id === 'code_review') {
      return `${header}
- You have NO handoff tool: handoffs belong to workers. Each reviewer calls handoff() to review_synthesizer with its own findings.

## Code review fan-in
This is an independent multi-lens review, not a mutation workflow:
${flowLines}

The repository is READ-ONLY. A clean review with no requested changes is a valid success.
1. Call set_plan with one step for each role.
2. Delegate review_lead first for scope. Then delegate implementation_reviewer,
   test_reviewer, and security_reviewer independently; one blocked lens must not
   prevent the others from producing findings.
3. Each of those four roles hands directly to review_synthesizer. After the
   available handoffs are recorded, delegate review_synthesizer to save the final
   report with save_artifact and give a verdict: approve, approve-with-nits, or request-changes.
4. Never ask a reviewer to install dependencies, run a fix command, edit files,
   or create a branch/commit/PR. GitHub review posting is handled by Hive after completion.
5. If every lens completes, call mark_goal_achieved. If a lens remains blocked,
   continue the independent lenses, have the synthesizer produce a caveated partial
   report, mark unfinished steps blocked, and call conclude_run.

${hardRules}`;
    }

    return `${header}
- You have NO handoff tool: handoffs belong to workers. Each worker calls handoff()
  itself when its work is done — you start and advance the flow with ask_agent only.

## Communication Protocol (A2A/ACP)
This crew follows a structured Communication Protocol. Workers share state on a
shared Blackboard and pass control with explicit, tool-based handoffs. The
handoff flow is fixed and preconditions are ENFORCED:

${flowLines}

${reviewLine}
${artifactSection}
## Delivery protocol
1. Call set_plan first with 3-6 steps that map DIRECTLY to this mission — nothing
   more. ASSIGN EACH STEP to the role whose EXPERTISE matches the work (set
   assigned_to to the role_key):
${expertiseLines}
2. Delegate STRICTLY in flow order, one role at a time, starting with ${flow[0].from}.
   A downstream role's preconditions are not met until the upstream handoff is on
   record — never skip ahead, and never ask a role to do another role's work.
   If a role has little to do for THIS mission, ask it for a brief review of its
   area and an immediate handoff — the chain must complete, but the scope must not
   grow to give every role "real" work.
3. Tell each worker to read the Blackboard, do its role's work, and finish with a
   handoff() to the next role in the flow. The worker's handoff carries the payload contract.
4. Plan steps auto-complete when a handoff is accepted. Use update_plan_step only
   for blocked steps or extra steps that do not map to a handoff.
5. If a worker returns a protocol violation (unknown task, failed precondition,
   not-understood), resolve the gap — re-delegate to the missing upstream role —
   instead of retrying the same handoff.
6. Hold every role to its expected artifact: a handoff whose deliverable does not
   exist as a file or concrete payload is not done — re-delegate demanding it.
7. If the crew works around missing access, weak tools, model limitations, or manual steps, call report_workaround with the issue, workaround, impact, and product recommendation.
8. Call mark_goal_achieved only after EVERY role has completed its handoff — the
   full chain must be on record (it is enforced; the call fails listing any
   missing handoffs).

${hardRules}`;
  }

  return `${header}
${artifactSection}
## Mission protocol
1. Call set_plan first with 3-6 concrete, mission-specific steps. Do not use a generic fixed template if the goal needs something else.
2. Delegate each step to the role whose expertise matches (address roles by role_key):
${expertiseLines}
3. Mark each step in_progress before delegation, and mark it done only after the worker returns usable output.
4. Hold every role to its expected artifact: prose claiming the work is "complete" without the deliverable is not done — re-delegate demanding it.
5. Add a plan step if the mission uncovers necessary follow-up work.
6. If the crew works around missing access, weak tools, model limitations, or manual steps, call report_workaround with the issue, workaround, impact, and product recommendation.
7. Call mark_goal_achieved with a concise summary only after all plan steps are done.

${hardRules}`;
}

function recipeInitialMessage(recipe) {
  if (!recipe || isCustomAutoRecipe(recipe.id)) {
    return 'Call set_plan now with 3-6 steps to accomplish the mission. This must be your first tool call - do not write any text first.';
  }

  return 'Start the selected mission preset now. Call set_plan first with a mission-specific checklist, then delegate to the seeded crew using the exact agent_id values in your system prompt.';
}

module.exports = {
  CUSTOM_AUTO_RECIPE_ID,
  DEFAULT_RECIPE_ID,
  listColonyRecipes,
  getColonyRecipe,
  isCustomAutoRecipe,
  isCodingRoleKey,
  buildRecipeWorkerConfigs,
  recipeOrchestratorPrompt,
  recipeInitialMessage,
};
