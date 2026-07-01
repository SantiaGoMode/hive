// Colony communication-protocol routes: the A2A/ACP REST surface (recipe flow,
// agent ID cards, blackboard, ACP messages, handoff ledger + HITL approval) and
// the human-triggered GitHub board write-back. Registered after the run routes.
const { getColony } = require('../../lib/colonyRunner');
const { detectGitHubRepo, postIssueComment, buildBoardComment } = require('../../lib/githubBoard');
const protocol = require('../../lib/colonyProtocol');
const { roleKeyForAgent, parseRepoSlug, getColonyRepoPath } = require('./shared');

module.exports = function registerProtocolRoutes(router) {
  // GET /api/colony/recipes/:rid/flow — the role-specific handoff flow + cards
  // (A2A discovery for a recipe, independent of any running colony).
  router.get('/recipes/:rid/flow', (req, res) => {
    const rid = req.params.rid;
    const flow = protocol.getFlow(rid);
    if (!flow) return res.status(404).json({ error: `No communication protocol flow for recipe "${rid}"` });
    res.json({ recipe_id: rid, flow, cards: protocol.buildAllCards(rid) });
  });

  // GET /api/colony/:id/agents — list A2A ID cards for the colony's roster.
  router.get('/:id/agents', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    if (!protocol.hasProtocol(colony.recipe_id)) {
      return res.json({ recipe_id: colony.recipe_id, protocol: false, cards: [] });
    }
    const byKey = {};
    for (const a of colony.agents) {
      const key = roleKeyForAgent(colony.recipe_id, a);
      if (key) byKey[key] = a;
    }
    const cards = protocol.buildAllCards(colony.recipe_id, { colonyId: colony.id }).map(card => ({
      ...card,
      agent_id: byKey[card.key]?.id || null,
      name: byKey[card.key]?.name || card.name,
    }));
    res.json({ recipe_id: colony.recipe_id, protocol: true, cards });
  });

  // GET /api/colony/:id/agents/:key/card — a single .agent.json ID card.
  router.get('/:id/agents/:key/card', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    const agent = colony.agents.find(a => roleKeyForAgent(colony.recipe_id, a) === req.params.key);
    const card = protocol.buildAgentCard(colony.recipe_id, req.params.key, {
      colonyId: colony.id,
      agentId: agent?.id || null,
      name: agent?.name,
      tools: undefined,
    });
    if (!card) return res.status(404).json({ error: `No role "${req.params.key}" in recipe "${colony.recipe_id}"` });
    res.json(card);
  });

  // GET /api/colony/:id/blackboard — read the shared context layer.
  router.get('/:id/blackboard', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    const entries = protocol.readBlackboard(colony.id, {
      entryType: req.query.entry_type,
      agent: req.query.agent,
      limit: req.query.limit,
    });
    res.json({ colony_id: colony.id, count: entries.length, entries });
  });

  // POST /api/colony/:id/blackboard — append an entry (ACP message ingress).
  router.post('/:id/blackboard', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    const { agent, entry_type, content } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required' });
    const entry = protocol.writeBlackboard(colony.id, agent || 'external', entry_type || 'message', content);
    res.json({ success: true, entry });
  });

  // POST /api/colony/:id/acp/messages — standardized ACP message ingress.
  router.post('/:id/acp/messages', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    const { from, to, performative, content } = req.body || {};
    if (content === undefined || content === null) return res.status(400).json({ error: 'content is required' });
    protocol.writeBlackboard(colony.id, from || 'external', 'message',
      typeof content === 'string' ? content : JSON.stringify(content), { to: to || null, performative: performative || 'inform' });
    res.json(protocol.acpEnvelope('message', { from: from || 'external', to, performative, content }));
  });

  // GET /api/colony/:id/handoffs — the handoff ledger (command objects).
  router.get('/:id/handoffs', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    res.json({ colony_id: colony.id, handoffs: protocol.listHandoffs(colony.id) });
  });

  // GET /api/colony/:id/handoffs/:hid/context — on-demand upstream history.
  router.get('/:id/handoffs/:hid/context', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    const context = protocol.getHandoffContext(req.params.hid);
    if (context.error) return res.status(404).json(context);
    if (context.handoff?.colony_id !== colony.id) return res.status(404).json({ error: 'Handoff not found for this colony' });
    res.json(context);
  });

  // POST /api/colony/:id/handoffs/:hid/approve — human-in-the-loop decision on a
  // critical handoff. decision: "approved" | "rejected".
  router.post('/:id/handoffs/:hid/approve', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    const handoff = protocol.getHandoff(req.params.hid);
    if (!handoff || handoff.colony_id !== colony.id) return res.status(404).json({ error: 'Handoff not found' });
    const decision = String(req.body?.decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
    }
    const note = req.body?.note ? String(req.body.note) : null;
    const updated = protocol.updateHandoff(handoff.id, {
      status: decision,
      human_decision: decision,
      human_note: note,
    });
    protocol.writeBlackboard(colony.id, 'human-reviewer', 'message',
      `Human ${decision} handoff ${handoff.from_agent}→${handoff.to_agent}${note ? `: ${note}` : ''}`,
      { handoff_id: handoff.id });
    res.json({ success: true, handoff: updated });
  });

  // POST /api/colony/:id/board/comment — human-triggered write-back: post the
  // colony's deliverable (or a custom body) as a comment on the linked GitHub
  // issue/PR. The safe half of board write-back; no destructive board mutations.
  router.post('/:id/board/comment', async (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });

    const card = colony.board_card;
    if (!card || !card.number) {
      return res.status(400).json({ error: 'This colony has no linked board work-item to comment on.' });
    }
    const repoPath = colony.repo_path || getColonyRepoPath();
    const repo = repoPath ? detectGitHubRepo(repoPath) : (card.repo ? parseRepoSlug(card.repo) : null);
    if (!repo) {
      return res.status(400).json({ error: 'Could not resolve a GitHub repo for this colony. Set its repo path.' });
    }

    const body = (req.body?.body && String(req.body.body).trim()) || buildBoardComment(colony);
    try {
      const comment = await postIssueComment({ owner: repo.owner, repo: repo.repo, number: card.number, body });
      res.json({ success: true, url: comment?.html_url || null });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
};
