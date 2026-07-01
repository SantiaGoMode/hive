// MCP server categorization for colony workers.
// Classify connected MCP servers by capability so we can attach them to the
// roles that actually need them — research (web/search/fetch) vs code (git/
// github/filesystem). A server can match more than one category.
const mcpManager = require('../mcpClient');

const MCP_CATEGORY_PATTERNS = {
  research: /(search|fetch|crawl|browser|brave|tavily|perplexity|firecrawl|web)/i,
  code: /(github|gitlab|\bgit\b|repo|pull[\s_-]?request|commit|issue|filesystem|\bfs\b|\bfile\b|code)/i,
};

function categorizeMcpServer(server) {
  const hay = `${server.name} ${(server.tool_names || []).join(' ')}`;
  return Object.entries(MCP_CATEGORY_PATTERNS)
    .filter(([, re]) => re.test(hay))
    .map(([cat]) => cat);
}

function connectedMcpServers() {
  return mcpManager.getStatus()
    .filter(server => server.enabled && server.connected && server.tool_count > 0)
    .map(server => ({ id: server.id, name: server.name, group: `mcp:${server.id}`, categories: categorizeMcpServer(server) }));
}

// Which MCP capability categories each role should receive. Keyed by the recipe
// role_key, with a name/role heuristic fallback for roles without an explicit key.
const ROLE_MCP_CATEGORIES = {
  business_analyst: ['research'],
  // The PM owns board upkeep — comments on the work item, status updates,
  // release notes — which needs the GitHub/code MCP tools.
  project_manager: ['code'],
  ui_ux_designer: ['research'],
  software_developer: ['code'],
  qa_engineer: ['code'],
  devops_engineer: ['code'],
  researcher: ['research'],
  source_critic: [],
  synthesizer: [],
};

function mcpCategoriesForWorker(workerConfig) {
  const key = workerConfig.role_key;
  if (key && ROLE_MCP_CATEGORIES[key]) return ROLE_MCP_CATEGORIES[key];
  const hay = `${workerConfig.persona_role || ''} ${workerConfig.name || ''}`.toLowerCase();
  if (/research|analyst/.test(hay)) return ['research'];
  if (/develop|devops|implement|\bbuild\b|engineer/.test(hay)) return ['code'];
  return [];
}

module.exports = {
  categorizeMcpServer,
  connectedMcpServers,
  mcpCategoriesForWorker,
};
