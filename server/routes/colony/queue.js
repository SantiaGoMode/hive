// Colony work-queue routes (colonies-first spec, R3/R4).
//
// Work reaches a colony as a queue item (proposed → queued → claimed) and the
// queue's Start step is the primary launch path: it collects the direction +
// model plan, creates the run, binds it to the item, and streams SSE exactly
// like the legacy POST /api/colony.
//
// Registered BEFORE the /:id run routes (see ./index.js) so /queue/* and
// /roster/* are never captured as run ids.
const { createColony } = require('../../lib/colonyRunner');
const colonyModels = require('../../lib/colonyModels');
const colonyTeams = require('../../lib/colonyTeams');
const workItems = require('../../lib/colonyWorkItems');
const { onRoster } = require('../../lib/rosterBus');
const { activeRuns, sseHeaders, sseWrite, runAndStreamColony } = require('./shared');

// Serialize a queue item into the run goal. Mirrors the client's
// boardCardToGoal (client/src/pages/colony/helpers.js) so runLabel /
// parseBoardGoal keep working on queue-launched runs.
function buildGoalFromItem(item, direction) {
  const card = item.board_card;
  const notes = String(direction || '').trim();
  if (!card) return notes || item.title;
  return [
    '[Connected Repo Board Item]',
    `Provider: ${card.provider || 'github'}`,
    `Repository: ${card.repo || 'Unknown'}`,
    `Type: ${card.type || 'project_item'}`,
    card.number ? `Number: #${card.number}` : '',
    `Title: ${card.title}`,
    `Status: ${card.status || 'backlog'}`,
    card.status_label ? `Board status: ${card.status_label}` : '',
    card.labels?.length ? `Labels: ${card.labels.join(', ')}` : '',
    card.assignees?.length ? `Assignees: ${card.assignees.join(', ')}` : '',
    `Source: ${card.source || 'project board'}`,
    card.url ? `URL: ${card.url}` : '',
    '',
    'Description:',
    card.description || '(no description)',
    notes ? `\nAdditional session notes:\n${notes}` : '',
  ].filter(Boolean).join('\n');
}

module.exports = function registerQueueRoutes(router) {
  // GET /api/colony/teams/:tid/queue — the colony's open work items.
  router.get('/teams/:tid/queue', (req, res) => {
    const team = colonyTeams.getTeam(req.params.tid);
    if (!team) return res.status(404).json({ error: 'Colony not found' });
    const includeClosed = req.query.all === '1';
    res.json(workItems.listWorkItems(team.id, { includeClosed }));
  });

  // POST /api/colony/teams/:tid/queue — give the colony work (board card or
  // free-form direction). Operator-added items land as queued; sources that
  // only *suggest* (intake) use status 'proposed'.
  router.post('/teams/:tid/queue', (req, res) => {
    const team = colonyTeams.getTeam(req.params.tid);
    if (!team) return res.status(404).json({ error: 'Colony not found' });
    const boardCard = req.body?.board_card && typeof req.body.board_card === 'object' ? req.body.board_card : null;
    try {
      const item = workItems.createWorkItem({
        teamId: team.id,
        source: boardCard ? 'board' : 'manual',
        sourceRef: boardCard?.id ? String(boardCard.id) : null,
        title: req.body?.title || '',
        direction: req.body?.direction || '',
        boardCard,
        status: 'queued',
        matchReason: 'added by operator',
      });
      res.json(item);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // PUT /api/colony/teams/:tid/queue/:itemId — accept (→ queued), dismiss,
  // edit title/direction, or reroute (team_id) a queue item.
  router.put('/teams/:tid/queue/:itemId', (req, res) => {
    const team = colonyTeams.getTeam(req.params.tid);
    if (!team) return res.status(404).json({ error: 'Colony not found' });
    const item = workItems.getWorkItem(req.params.itemId);
    if (!item || item.team_id !== team.id) return res.status(404).json({ error: 'Work item not found' });
    if (req.body?.status === 'claimed') return res.status(400).json({ error: 'Use the start endpoint to claim an item' });
    if (req.body?.team_id !== undefined && req.body.team_id && !colonyTeams.getTeam(req.body.team_id)) {
      return res.status(400).json({ error: 'unknown team_id' });
    }
    try {
      res.json(workItems.updateWorkItem(item.id, req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // DELETE /api/colony/teams/:tid/queue/:itemId
  router.delete('/teams/:tid/queue/:itemId', (req, res) => {
    const team = colonyTeams.getTeam(req.params.tid);
    if (!team) return res.status(404).json({ error: 'Colony not found' });
    const item = workItems.getWorkItem(req.params.itemId);
    if (!item || item.team_id !== team.id) return res.status(404).json({ error: 'Work item not found' });
    workItems.deleteWorkItem(item.id);
    res.json({ success: true });
  });

  // POST /api/colony/teams/:tid/queue/:itemId/start — the queue launch path.
  // Collects/edits the direction + model plan, creates a run linked to both
  // the team and the item, and streams the run as SSE (same contract as
  // POST /api/colony).
  router.post('/teams/:tid/queue/:itemId/start', async (req, res) => {
    const team = colonyTeams.getTeam(req.params.tid);
    if (!team) return res.status(404).json({ error: 'Colony not found' });
    const item = workItems.getWorkItem(req.params.itemId);
    if (!item || item.team_id !== team.id) return res.status(404).json({ error: 'Work item not found' });
    if (!['proposed', 'queued'].includes(item.status)) {
      return res.status(400).json({ error: `Work item is ${item.status} — only proposed or queued items can start` });
    }
    const model = String(req.body?.model || '').trim();
    if (!model) return res.status(400).json({ error: 'model is required' });

    // Direction is stored on the item and editable at Start (spec Q4).
    const direction = req.body?.direction !== undefined ? String(req.body.direction || '') : item.direction;
    const goal = buildGoalFromItem(item, direction);
    if (!goal.trim()) return res.status(400).json({ error: 'The work item has no direction or board card to run' });

    const modelPlan = req.body?.model_plan && typeof req.body.model_plan === 'object' ? req.body.model_plan : null;
    const gate = colonyModels.gatePlan({ operator: model, ...(modelPlan || {}) }, team.cloud_enabled);
    if (!gate.ok) return res.status(400).json({ error: gate.error });

    const colonyId = createColony(goal, model, team.recipe_id, {
      repoPath: team.repo_path || null,
      // Backward compatible: the run's board_card is still populated at launch,
      // sourced from the claimed queue item.
      boardCard: item.board_card,
      cloudEnabled: team.cloud_enabled,
      githubWriteback: team.github_writeback,
      modelPlan,
      reasoningMode: 'auto',
      teamId: team.id,
    });
    workItems.claimWorkItem(item.id, colonyId, direction);

    await runAndStreamColony(res, colonyId);
  });

  // GET /api/colony/queue/unrouted — incoming work no colony owns yet.
  router.get('/queue/unrouted', (req, res) => {
    res.json(workItems.listUnroutedItems());
  });

  // PUT /api/colony/queue/:itemId — route/dismiss an Unrouted item (assign a
  // team_id, or status: 'dismissed').
  router.put('/queue/:itemId', (req, res) => {
    const item = workItems.getWorkItem(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Work item not found' });
    if (req.body?.status === 'claimed') return res.status(400).json({ error: 'Use the start endpoint to claim an item' });
    if (req.body?.team_id !== undefined && req.body.team_id && !colonyTeams.getTeam(req.body.team_id)) {
      return res.status(400).json({ error: 'unknown team_id' });
    }
    try {
      res.json(workItems.updateWorkItem(item.id, req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // GET /api/colony/roster/stream — SSE hints for the roster page. Payloads
  // are coarse ("something changed"); the client refetches the roster/queues.
  router.get('/roster/stream', (req, res) => {
    sseHeaders(res);
    sseWrite(res, { type: 'roster_hello', active_runs: activeRuns.size });
    const unsubscribe = onRoster((event) => sseWrite(res, event));
    // Keep intermediaries from timing out the idle stream.
    const heartbeat = setInterval(() => sseWrite(res, { type: 'ping' }), 30000);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
};
