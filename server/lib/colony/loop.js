// Orchestrator review-loop helpers.
// Between outer turns the runner injects a state-aware nudge showing the current
// plan status and worker roster (so the operator never has to invent agent IDs),
// steering it toward the next legal action.
const db = require('../../db');
const { readAgent } = require('../agentParser');
const protocol = require('../colonyProtocol');

// Build a state-aware nudge from the current plan + worker list in the DB.
// `ctx` = { colonyId, outer, maxOuterRounds, delegatedSteps }
function buildRoundNudge({ colonyId, outer, maxOuterRounds, delegatedSteps }) {
  const planRow = db.prepare('SELECT plan, agent_ids, orchestrator_id, recipe_id FROM colonies WHERE id=?').get(colonyId);
  const plan = planRow?.plan ? JSON.parse(planRow.plan) : null;

  // Always include current worker list so the orchestrator never needs to invent IDs.
  const allIds = JSON.parse(planRow?.agent_ids || '[]');
  const orchId = planRow?.orchestrator_id;
  const workerIds = allIds.filter(id => id !== orchId);
  const workerLines = workerIds.map(id => {
    const a = readAgent(id);
    return a ? `  • "${a.name}" → agent_id: "${a.id}"` : null;
  }).filter(Boolean);

  let nudge = `Round ${outer + 2} of ${maxOuterRounds}.\n`;

  if (workerLines.length > 0) {
    nudge += `\nYour workers (use these exact agent_id values in ask_agent):\n${workerLines.join('\n')}\n`;
  }

  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    nudge += '\nYou have not called set_plan yet. Call it NOW with 3–6 concrete steps before creating workers or doing anything else.\n';
  } else {
    const done = plan.steps.filter(s => s.status === 'done');
    const pending = plan.steps.filter(s => s.status !== 'done');

    if (done.length > 0) {
      const doneLines = done.map(s => `  ✓ [DONE] ${s.id}. ${s.description}`);
      nudge += `\nCompleted steps (do NOT reopen, do NOT call set_plan):\n${doneLines.join('\n')}\n`;
    }

    if (pending.length === 0) {
      nudge += '\n*** ALL STEPS DONE *** Call mark_goal_achieved RIGHT NOW with a summary of what was accomplished. Do NOT create new steps or call set_plan — the plan is complete.\n';
    } else {
      const firstUnfinished = plan.steps.find(s => s.status !== 'done');
      const strictBlocked = protocol.hasProtocol(planRow?.recipe_id) && firstUnfinished?.status === 'blocked';
      const lines = pending.map(s => {
        const alreadyDelegated = delegatedSteps.has(String(s.id));
        const hint = (s.status === 'in_progress' && alreadyDelegated)
          ? ' ← ask_agent already called; mark this DONE now'
          : s.status === 'in_progress'
            ? ' ← call ask_agent to do the work, then mark done'
            : '';
        return `  - [${s.status}] ${s.id}. ${s.description}${s.assigned_to ? ' → ' + s.assigned_to : ''}${hint}`;
      });
      nudge += `\nRemaining steps:\n${lines.join('\n')}\n\nAddress errors above, then continue with the next step. If a step is in_progress and ask_agent already ran for it, mark it done immediately.\n`;
      if (strictBlocked) {
        nudge += `\nA strict handoff flow is blocked at step "${firstUnfinished.id}". Do NOT delegate downstream roles out of flow; their handoffs cannot count until this blocker is resolved. If you cannot resolve the blocker with a materially different concrete approach, mark every remaining dependent step blocked with a note, then call mark_goal_achieved to conclude the run as FAILED.\n`;
      }
    }
  }

  return nudge;
}

module.exports = { buildRoundNudge };
