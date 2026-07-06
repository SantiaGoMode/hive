// Colony runner façade.
// The colony orchestration was split into cohesive modules under ./colony/
// (issue #28). This file preserves the original public API so all callers —
// routes/colony.js, colonyTeams.js, colonyTriggers.js, agentTools, and the test
// suite — keep working unchanged. It re-exports from the new modules.
const { runColony, stopColonyRun, isColonyRunning, activeRunCount, COLONY_MAX_DURATION_MS } = require('./colony/runner');
const {
  createColony,
  listColonies,
  getColony,
  deleteColony,
} = require('./colony/persistence');
const { truncateArgs, truncateResult } = require('./colony/format');
const { categorizeMcpServer, mcpCategoriesForWorker } = require('./colony/mcp');
const { parseBootstrapTasks, readBootstrapSource } = require('./colony/bootstrap');

module.exports = {
  runColony,
  stopColonyRun,
  isColonyRunning,
  activeRunCount,
  COLONY_MAX_DURATION_MS,
  createColony,
  listColonies,
  getColony,
  deleteColony,
  truncateArgs,
  truncateResult,
  categorizeMcpServer,
  mcpCategoriesForWorker,
  parseBootstrapTasks,
  readBootstrapSource,
};
