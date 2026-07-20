// Colony run lifecycle routes: create+stream a run, stop it, queue human
// directions, and accept bootstrap task drafts. These own the process-global
// activeRuns registry and the SSE stream for a freshly launched run.
const { stopColonyRun, getColony } = require('../../lib/colonyRunner');
const colonyRunService = require('../../lib/colonyRunService');
const colonyJobs = require('../../lib/colonyJobs');
const { getBus, hasBus } = require('../../lib/colonyBus');
const { DEFAULT_RECIPE_ID, getColonyRecipe } = require('../../lib/colonyRecipes');
const { detectGitHubRepo, createGitHubIssue } = require('../../lib/githubBoard');
const protocol = require('../../lib/colonyProtocol');
const colonyModels = require('../../lib/colonyModels');
const { normalizeTriggerConfig } = require('../../lib/colonyTriggers');
const colonyTeams = require('../../lib/colonyTeams');
const db = require('../../db');
const { activeRuns, runAndStreamColony, getColonyRepoPath } = require('./shared');

module.exports = function registerLifecycleRoutes(router) {
  // POST /api/colony — create + immediately stream via SSE
  router.post('/', async (req, res) => {
    const { goal, model } = req.body;
    if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
    if (!model?.trim()) return res.status(400).json({ error: 'model is required' });

    // Runs are launched under a colony team — the team carries the repo/project,
    // recipe, and base config set at colony creation. team_id is optional only
    // for backward compatibility (tests, webhooks, scripts).
    const team = req.body.team_id ? colonyTeams.getTeam(req.body.team_id) : null;
    if (req.body.team_id && !team) return res.status(400).json({ error: 'unknown team_id' });

    const recipeId = team?.recipe_id || req.body.recipe_id || DEFAULT_RECIPE_ID;
    if (getColonyRecipe(recipeId).id !== recipeId) return res.status(400).json({ error: 'unknown recipe_id' });

    // Repo comes from the team; fall back to body / global path for teamless launches.
    const repoPath = (team?.repo_path || req.body.repo_path || getColonyRepoPath() || '').trim() || null;
    const boardCard = req.body.board_card && typeof req.body.board_card === 'object' ? req.body.board_card : null;
    const cloudEnabled = team ? team.cloud_enabled : !!req.body.cloud_enabled;
    const recipe = getColonyRecipe(recipeId);
    const policy = require('../../lib/colonyPolicy').recipeExecutionPolicy(recipe);
    const githubReview = policy.github_review && (team ? team.github_review : !!req.body.github_review);
    const githubPublish = policy.mode === 'repository_write' && (team
      ? team.github_publish
      : !!(req.body.github_publish ?? req.body.github_writeback));
    const modelPlan = req.body.model_plan && typeof req.body.model_plan === 'object' ? req.body.model_plan : null;
    // Reasoning is no longer a per-run user toggle: the operator always reasons
    // and decides per-agent reasoning at run start (see colonyRunner).
    const reasoningMode = 'auto';
    let triggerConfig = normalizeTriggerConfig(req.body.trigger_config);
    if (triggerConfig && !triggerConfig.repo && repoPath) {
      const detected = detectGitHubRepo(repoPath);
      if (detected) triggerConfig = { ...triggerConfig, repo: `${detected.owner}/${detected.repo}` };
    }
    if (triggerConfig && !triggerConfig.webhook_id && triggerConfig.event_types.length === 0) triggerConfig = null;

    // Reject a plan that uses cloud models when cloud is disabled, before launch.
    const gate = colonyModels.gatePlan({ operator: model, ...(modelPlan || {}) }, cloudEnabled);
    if (!gate.ok) return res.status(400).json({ error: gate.error });

    let colonyId;
    try {
      colonyId = colonyRunService.createRun({
        goal: goal.trim(), model: model.trim(), recipeId, repoPath, boardCard,
        cloudEnabled, githubReview, githubPublish, modelPlan, reasoningMode,
        triggerConfig, teamId: team?.id || null,
      });
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    await runAndStreamColony(res, colonyId);
  });

  // POST /api/colony/:id/stop
  // Stop is owned by the runner's registry, which covers every launch path
  // (direct POST, bootstrap accept, webhook triggers) for the run's full
  // lifetime — not just while the original POST handler is open.
  router.post('/:id/stop', (req, res) => {
    const colonyId = req.params.id;
    const colony = getColony(colonyId);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });

    // Abort the live run if there is one (runner registry), and also abort the
    // route-local controller (clears the POST wall-clock timeout path).
    const stoppedLive = stopColonyRun(colonyId);
    const stoppedJob = colonyJobs.stop(colonyId);
    const ac = activeRuns.get(colonyId);
    if (ac) {
      try { ac.abort(); } catch {} /* abort is best-effort */
      activeRuns.delete(colonyId);
    }

    if (stoppedLive || stoppedJob || ac) {
      // The runner's abort handling persists status='stopped' and emits 'done'.
      return res.json({ success: true, stopped: true });
    }

    // No live run, but the row may be stuck at 'running' (e.g. server restarted
    // mid-run). Reconcile the DB so the UI stops showing a phantom run.
    if (colony.status === 'running') {
      db.prepare("UPDATE colonies SET status='stopped', updated_at=unixepoch() WHERE id=?").run(colonyId);
      if (hasBus(colonyId)) {
        getBus(colonyId).emit('event', { type: 'done', status: 'stopped' });
      }
      return res.json({ success: true, stopped: true, message: 'No live run; stale running status reconciled' });
    }

    res.json({ success: true, stopped: false, message: 'Not running' });
  });

  // POST /api/colony/:id/directions — queue human direction for the operator.
  // The runner drains this between review rounds and marks it delivered.
  router.post('/:id/directions', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    if (colony.status !== 'running') return res.status(400).json({ error: 'Directions can only be sent to a running colony.' });
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content is required' });
    const targetRole = req.body?.target_role ? String(req.body.target_role) : null;
    const info = db.prepare('INSERT INTO colony_directions (colony_id, content, target_role) VALUES (?, ?, ?)')
      .run(colony.id, content, targetRole);
    protocol.writeBlackboard(colony.id, 'user', 'message', content, { direction_id: info.lastInsertRowid, queued_for_operator: true, target_role: targetRole });
    if (hasBus(colony.id)) {
      getBus(colony.id).emit('event', {
        type: 'direction_queued',
        direction: { id: info.lastInsertRowid, content, target_role: targetRole },
      });
    }
    res.json({ success: true, direction: { id: info.lastInsertRowid, status: 'queued', content, target_role: targetRole } });
  });

  // POST /api/colony/:id/bootstrap/accept — human gate for empty-board task drafts.
  router.post('/:id/bootstrap/accept', async (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    let tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : colony.bootstrap_tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) return res.status(400).json({ error: 'No bootstrap tasks are available to accept.' });
    const job = colonyJobs.status(colony.id);
    if (job && ['queued', 'running'].includes(job.status)) return res.status(400).json({ error: 'Colony is already running.' });

    // Handle GitHub write-back
    if (colony.github_publish && colony.repo_path) {
      const detected = detectGitHubRepo(colony.repo_path);
      if (detected) {
        try {
          const updatedTasks = [];
          for (const task of tasks) {
            const bodyLines = [];
            if (task.description) bodyLines.push(task.description);
            if (Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length) {
              bodyLines.push('', '### Acceptance Criteria');
              task.acceptance_criteria.forEach(c => bodyLines.push(`- [ ] ${c}`));
            }
            const issue = await createGitHubIssue({
              owner: detected.owner,
              repo: detected.repo,
              title: task.title,
              body: bodyLines.join('\n')
            });
            updatedTasks.push({ ...task, github_issue_number: issue.number });
          }
          tasks = updatedTasks;
        } catch (err) {
          console.error('Failed to create GitHub issues during bootstrap:', err);
          protocol.writeBlackboard(colony.id, 'system', 'blocker',
            `Failed to create GitHub issues for bootstrap tasks: ${err.message}. Please check your GitHub token and permissions.`,
            { error: err.message });
        }
      }
    }

    const plan = {
      steps: tasks.map((task, i) => ({
        id: String(task.id || i + 1),
        description: [
          task.title,
          task.description ? `- ${task.description}` : '',
          Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length
            ? `Acceptance: ${task.acceptance_criteria.join('; ')}`
            : '',
          task.github_issue_number ? `(GitHub Issue #${task.github_issue_number})` : ''
        ].filter(Boolean).join(' '),
        github_issue_number: task.github_issue_number,
        assigned_to: null,
        status: 'pending',
      })),
      updated_at: Date.now(),
      source: 'bootstrap_tasks',
    };
    db.prepare("UPDATE colonies SET bootstrap_tasks=?, bootstrap_accepted=1, plan=?, status='running', updated_at=unixepoch() WHERE id=?")
      .run(JSON.stringify(tasks), JSON.stringify(plan), colony.id);
    require('../../lib/colony/workflow').syncPlan(colony.id, plan.steps);
    protocol.writeBlackboard(colony.id, 'human-reviewer', 'message',
      `Accepted ${tasks.length} bootstrap task(s). The colony may now continue with the normal delivery flow.`,
      { bootstrap_accepted: true, task_count: tasks.length });

    colonyRunService.enqueueExisting(colony.id);

    res.json({ success: true, colony: getColony(colony.id) });
  });
};
