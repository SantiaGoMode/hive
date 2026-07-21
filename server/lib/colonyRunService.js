// Single command boundary for creating, claiming, and enqueueing Colony runs.
const db = require('../db');
const { createColony } = require('./colonyRunner');
const workItems = require('./colonyWorkItems');
const jobs = require('./colonyJobs');

function createRun(input, { workItemId = null, direction = undefined, enqueue = true } = {}) {
  const tx = db.transaction(() => {
    if (input.teamId) {
      const active = db.prepare(`SELECT run_id FROM colony_run_jobs
        WHERE team_id=? AND status IN ('queued','running') LIMIT 1`).get(input.teamId);
      if (active) throw new Error(`This colony already has active run ${active.run_id}`);
    }
    if (workItemId) {
      const item = workItems.getWorkItem(workItemId);
      if (!item || !['proposed', 'queued'].includes(item.status)) {
        throw new Error('Work item is no longer available to start');
      }
    }
    const runId = createColony(input.goal, input.model, input.recipeId, {
      repoPath: input.repoPath,
      boardCard: input.boardCard,
      cloudEnabled: input.cloudEnabled,
      githubReview: input.githubReview,
      githubPublish: input.githubPublish,
      modelPlan: input.modelPlan,
      reasoningMode: 'auto',
      triggerConfig: input.triggerConfig,
      trigger: input.trigger,
      teamId: input.teamId,
      contextBudget: input.contextBudget,
    });
    jobs.ensureJob(runId, input.teamId);
    if (workItemId) workItems.claimWorkItem(workItemId, runId, direction);
    return runId;
  });
  const runId = tx.immediate();
  if (enqueue) jobs.enqueue(runId, input.teamId);
  return runId;
}

function enqueueExisting(runId) {
  const row = db.prepare('SELECT id, team_id FROM colonies WHERE id=?').get(runId);
  if (!row) throw new Error('Colony run not found');
  return jobs.enqueue(runId, row.team_id);
}

module.exports = { createRun, enqueueExisting };
