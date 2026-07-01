// Façade for the agent tool system (#27). The former 2,400-line monolith was
// split into a registry + per-domain tool modules under ./tools/ and the agent
// runner (runAgentOnce). This module preserves the original public API so every
// existing caller (websocket, colonyRunner, pipelineRunner, scheduler,
// webhookActions, skills route, staffScheduler) keeps working unchanged.
const { runAgentOnce } = require('./agentRunner');
const { getToolDefinitions, executeTool, builtInToolCatalog } = require('./tools/registry');
const { readMemory, readShared, isPermissionError } = require('./tools/shared');

module.exports = { getToolDefinitions, executeTool, runAgentOnce, readMemory, readShared, isPermissionError, builtInToolCatalog };
