// Post-run colony memory update.
// After each run the operator distills what the team should remember — outcome,
// gotchas, workarounds, open blockers — and appends it to the colony's shared
// memory (editable on the colony page, injected into the next run's prompts).
// Non-fatal: any failure here never affects the run result.
const protocol = require('../colonyProtocol');
const staffDirectory = require('../staffDirectory');
const { getColonyRecipe, DEFAULT_RECIPE_ID } = require('../colonyRecipes');
const { logSwallowed } = require('../logSwallowed');
const { getColony } = require('./persistence');

async function updateColonyMemoryAfterRun(colonyId, row, goalSummary, status, addEntry, verifiedOutcome = null) {
  // Staff memory: every recipe-role profile that crewed this run gets a short
  // dated note (what ran, how it ended) — so the Staff tab's Memory sections
  // accumulate real history without waiting for suggestion applies.
  try {
    const recipe = getColonyRecipe(row.recipe_id || DEFAULT_RECIPE_ID);
    if (Array.isArray(recipe.roles) && recipe.roles.length) {
      const note = `- ${new Date().toISOString().slice(0, 10)} · run ${colonyId} (${status}): ${String(row.goal || '').split('\n')[0].slice(0, 100)}${goalSummary ? ` — ${String(goalSummary).replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
      for (const role of recipe.roles) {
        const profile = staffDirectory.getProfileByRole(recipe.id, role.key);
        if (profile) staffDirectory.appendProfileMemory(profile.id, note);
      }
    }
  } catch (e) { logSwallowed('colonyRunner:staffMemory', e, { colonyId }); }

  if (!row?.team_id) return;
  const colonyTeams = require('../colonyTeams');
  const team = colonyTeams.getTeam(row.team_id);
  if (!team) return;

  const fresh = getColony(colonyId);
  const deliverable = fresh?.deliverable || null;
  const workarounds = Array.isArray(deliverable?.workarounds) ? deliverable.workarounds : [];
  let blockers = [];
  try { blockers = protocol.readBlackboard(colonyId, { entryType: 'blocker', limit: 5 }); } catch (e) { logSwallowed('colonyRunner:readBlackboard', e, { colonyId }); }
  if (!goalSummary && !workarounds.length && !blockers.length) return;

  const providers = require('../providers');
  const model = (fresh?.model_plan && fresh.model_plan.operator) || row.model;
  const sys = [
    "You are the Colony Operator maintaining your team's shared memory — durable knowledge that future runs will read.",
    'Distill ONLY what is worth remembering across runs: repo/tooling gotchas, decisions made, recurring failure modes, follow-ups owed.',
    'Do NOT restate the mission or narrate the run. No praise, no filler.',
    // Memory-poisoning guard: a fabricated summary once put "Draft PR #4
    // verified by QA/DevOps" into memory and the next run repeated it as fact.
    'The VERIFIED OUTCOME line is ground truth measured from git. Any claim about PRs, branches, commits, deployments, installed dependencies, or QA sign-off that contradicts or is not backed by it is a model fabrication — never record such a claim as fact (recording "the summary fabricated X" as a failure mode is fine).',
    'Respond with 2–5 plain bullet lines, each starting with "- ", each under 200 characters. Nothing else.',
  ].join(' ');
  const user = [
    `Mission: ${row.goal}`,
    `Run status: ${status}`,
    verifiedOutcome?.message ? `VERIFIED OUTCOME (ground truth): ${verifiedOutcome.message}` : '',
    goalSummary ? `Outcome summary (model-written, may contain unverified claims): ${goalSummary}` : '',
    workarounds.length ? `Workarounds reported:\n${workarounds.map(w => `- ${w.issue || ''} → ${w.recommendation || w.workaround || ''}`).join('\n')}` : '',
    blockers.length ? `Open blockers:\n${blockers.map(b => `- ${String(b.content || '').slice(0, 200)}`).join('\n')}` : '',
    `Existing memory (avoid duplicating notes already present):\n${String(team.memory || '(empty)').slice(-3000)}`,
  ].filter(Boolean).join('\n\n');

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45000);
    let raw;
    try {
      raw = await providers.generateText(model, [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], { signal: ac.signal, temperature: 0.2, metadata: { colony_id: colonyId, source: 'memory_synthesis' } });
    } finally {
      clearTimeout(timer);
    }
    const bullets = String(raw || '').split('\n')
      .map(l => l.trim().replace(/^[-*]\s+/, ''))
      .filter(l => l && !/^#/.test(l))
      .slice(0, 5)
      .map(l => l.slice(0, 300));
    if (!bullets.length) return;
    const title = `Run ${colonyId} — ${new Date().toISOString().slice(0, 10)} (${status})`;
    colonyTeams.appendTeamMemory(team.id, title, bullets);
    addEntry({ kind: 'memory', message: `🧠 Operator updated colony memory (${bullets.length} note${bullets.length === 1 ? '' : 's'}).` });
  } catch {
    // Memory upkeep is best-effort.
  }
}

module.exports = { updateColonyMemoryAfterRun };
