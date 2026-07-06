// Single source of truth for the built-in tool-group catalog and the tool-picker
// selection logic (issue #4). Previously the catalog + toggle were copy-pasted in
// PipelinesPage and SchedulesPage. Kept framework-free so it's unit-testable; the
// <ToolPicker> component renders from these.

// Built-in tool groups selectable as step/schedule/agent overrides. Ids match the
// server's tool-group keys; `mcp:<id>` ids (added at render time) live alongside.
export const BUILTIN_TOOL_GROUPS = [
  { id: 'agent_tools', label: 'Agent Tools', desc: 'Create, run, and manage agents, pipelines, and schedules' },
  { id: 'memory',      label: 'Memory',      desc: 'Save and recall info across sessions' },
  { id: 'web_search',  label: 'Web Search',  desc: 'Built-in Ollama web search/fetch; requires ollama signin' },
  { id: 'sandbox',     label: 'Sandbox',     desc: 'Run code and shell commands in an isolated Docker container' },
  { id: 'github',      label: 'GitHub',      desc: 'Comment on/update issues, file issues, read security alerts on the linked repo' },
];

// Toggle a tool id in/out of the selection (returns a new array; never mutates).
export function toggleTool(tools, id) {
  const list = Array.isArray(tools) ? tools : [];
  return list.includes(id) ? list.filter(t => t !== id) : [...list, id];
}

// Resolve the picker's display rows for a given selection + MCP server list. Pure,
// so selected/connected state is testable without rendering. MCP ids are the
// `mcp:<serverId>` form the rest of Hive uses.
export function toolPickerModel(tools = [], mcpServers = [], builtinGroups = BUILTIN_TOOL_GROUPS) {
  const selected = new Set(Array.isArray(tools) ? tools : []);
  const builtin = builtinGroups.map(g => ({ ...g, selected: selected.has(g.id) }));
  const mcp = (mcpServers || []).map(s => {
    const id = `mcp:${s.id}`;
    return {
      id,
      name: s.name,
      selected: selected.has(id),
      connected: !!s.connected,
      toolCount: s.tool_count,
    };
  });
  return { builtin, mcp, overrideCount: selected.size };
}
