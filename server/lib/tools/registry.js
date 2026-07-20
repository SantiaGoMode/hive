// Tool registry (#27): merges the per-domain tool modules into one map and
// provides getToolDefinitions / executeTool / builtInToolCatalog. Each domain
// module exports `{ name: { group|groups, definition, handler } }` entries.
const mcpManager = require('../mcpClient');
const { MAX_SUB_ROUNDS } = require('./shared');

const TOOLS = {
  ...require('./agentManagement'),
  ...require('./collaborationTools'),
  ...require('./protocolTools'),
  ...require('./protocolReportingTools'),
  ...require('./colonyPlanTools'),
  ...require('./pipelineTools'),
  ...require('./scheduleTools'),
  ...require('./sandboxTools'),
  ...require('./memoryTools'),
  ...require('./webTools'),
  ...require('./githubTools'),
  ...require('./skillTools'),
  ...require('./operatorTools'),
  ...require('./adminTools'),
  ...require('./mediaTools'),
};

const REPO_MUTATION_TOOLS = new Set([
  'shell', 'run_python', 'install_package', 'start_server', 'stop_server',
  'write_file', 'delete_file', 'move_file',
]);
const GITHUB_WRITE_TOOLS = new Set(['github_comment', 'github_update_issue', 'github_create_issue']);

function capabilityError(name, colonyContext) {
  const caps = colonyContext?.capabilities;
  if (!caps) return null;
  if (GITHUB_WRITE_TOOLS.has(name) && !caps.github_write) {
    return `Tool "${name}" is denied by this run's capability policy (github_write=false). External GitHub mutations require explicit publish/write permission.`;
  }
  if (REPO_MUTATION_TOOLS.has(name) && !caps.repo_write) {
    // Repo-less artifact workers may use their isolated scratch filesystem and
    // then persist outputs through save_artifact. A connected read-only repo is
    // the boundary that must never be mutated.
    if (!caps.repo_read && caps.artifact_write && ['write_file', 'delete_file', 'move_file'].includes(name)) return null;
    return `Tool "${name}" is denied by this run's capability policy (repo_write=false). Use read-only inspection and save_artifact instead.`;
  }
  return null;
}

function getToolDefinitions(enabledGroups = []) {
  if (!enabledGroups.length) return [];

  const builtIn = Object.values(TOOLS)
    .filter(t => {
      const groups = Array.isArray(t.groups) ? t.groups : [t.group];
      return groups.some(group => enabledGroups.includes(group));
    })
    .map(t => t.definition);

  const mcpServerIds = enabledGroups
    .filter(g => g.startsWith('mcp:'))
    .map(g => g.slice(4));
  const mcpDefs = mcpManager.getToolDefinitions(mcpServerIds);

  return [...builtIn, ...mcpDefs];
}

// ── Execute a tool call ───────────────────────────────────────────────────────
async function executeTool(name, args, callerAgentId, ollamaUrl, depth = 0, workspace = null, hivePath = null, ws = null, maxRounds = MAX_SUB_ROUNDS, signal = null, colonyContext = null) {
  // Per-agent call counter — lets ask_agent detect a worker that "responded"
  // with prose but executed nothing (common with small coding models).
  if (colonyContext && callerAgentId) {
    const counts = (colonyContext.toolCallsByAgent ||= new Map());
    counts.set(callerAgentId, (counts.get(callerAgentId) || 0) + 1);
  }
  const denied = capabilityError(name, colonyContext);
  if (denied) return { error: denied, policy_denied: true };

  // Route MCP tools first
  if (mcpManager.isMcpTool(name)) {
    try {
      const result = await mcpManager.callTool(name, args);
      return { result };
    } catch (err) {
      return { error: err.message };
    }
  }

  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    return await tool.handler(args, { callerAgentId, ollamaUrl, depth, workspace, hivePath, ws, maxRounds, signal, colonyContext });
  } catch (err) {
    if (err.name === 'AbortError' || err.message === 'Colony run was stopped') throw err;
    return { error: err.message };
  }
}

// Map of built-in tool group → list of { name, description } for every function
// in that group. Used by the Skills & Tools UI to show what each group exposes.
function builtInToolCatalog() {
  const catalog = {};
  for (const tool of Object.values(TOOLS)) {
    const groups = Array.isArray(tool.groups) ? tool.groups : [tool.group];
    for (const group of groups) {
      if (!group) continue;
      (catalog[group] ||= []).push({
        name: tool.definition?.function?.name || '',
        description: tool.definition?.function?.description || '',
      });
    }
  }
  return catalog;
}

module.exports = { TOOLS, getToolDefinitions, executeTool, builtInToolCatalog, capabilityError };
