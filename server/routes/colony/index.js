// Colony route composition.
//
// routes/colony.js (~775 lines) was split into focused modules under this
// directory. Each module exports a register(router) function that attaches its
// handlers to the ONE express router built here. Registration order is
// significant and mirrors the original file exactly:
//
//   1. meta       — fixed top-level routes (list, recipes, propose-models, repo,
//                   project-board)
//   2. teams      — /teams* routes, declared BEFORE /:id so "teams" is never
//                   matched as a run id
//   3. runs       — run reads: /:id, /:id/artifact, /:id/triggers, /:id/stream
//   4. lifecycle  — run writes: POST /, /:id/stop, /:id/directions,
//                   /:id/bootstrap/accept
//   5. protocol   — A2A/ACP surface (/recipes/:rid/flow, agents, blackboard,
//                   acp, handoffs) + /:id/board/comment
//   6. DELETE /:id — last, matching the original file's tail
//
// The mounted path (/api/colony in server/index.js) and every path, method,
// validation, and SSE behavior are preserved. Logic was moved, not rewritten.
const express = require('express');
const router = express.Router();
const { deleteColony } = require('../../lib/colonyRunner');
const { activeRuns } = require('./shared');

require('./meta')(router);
require('./teams')(router);
require('./runs')(router);
require('./lifecycle')(router);
require('./protocol')(router);

// DELETE /api/colony/:id — declared last, as in the original router.
router.delete('/:id', (req, res) => {
  const ac = activeRuns.get(req.params.id);
  if (ac) { ac.abort(); activeRuns.delete(req.params.id); }
  try {
    deleteColony(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
