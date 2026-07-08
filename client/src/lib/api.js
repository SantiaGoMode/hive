const BASE = '/api';
const AUTH_STORAGE_KEY = 'hive.authToken';

export function getHiveAuthToken() {
  // Desktop shell injects the token via preload — no paste-a-token prompt.
  const desktopToken = typeof window !== 'undefined' ? window.hiveDesktop?.authToken : '';
  if (desktopToken) return desktopToken;
  const envToken = import.meta.env?.VITE_HIVE_AUTH_TOKEN || '';
  if (envToken) return envToken;
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setHiveAuthToken(token) {
  try {
    if (token) localStorage.setItem(AUTH_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch { /* storage unavailable (private mode) — token stays session-only */ }
}

// Fired when the server rejects our credentials; the AuthGate listens and
// prompts for the token.
export const UNAUTHORIZED_EVENT = 'hive:unauthorized';

function notifyUnauthorized() {
  try { window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT)); } catch { /* non-browser env */ }
}

function authHeaders(headers = {}) {
  const token = getHiveAuthToken();
  return token ? { ...headers, 'x-hive-auth-token': token } : headers;
}

async function req(method, path, body) {
  const opts = { method, headers: authHeaders({ 'Content-Type': 'application/json' }) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  // Agents
  getAgents: () => req('GET', '/agents'),
  getAgent: (id) => req('GET', `/agents/${id}`),
  createAgent: (data) => req('POST', '/agents', data),
  updateAgent: (id, data) => req('PUT', `/agents/${id}`, data),
  deleteAgent: (id) => req('DELETE', `/agents/${id}`),
  getAgentMemory: (id) => req('GET', `/agents/${id}/memory`),
  updateAgentMemory: (id, content) => req('PUT', `/agents/${id}/memory`, { content }),
  clearAgentMemory: (id) => req('DELETE', `/agents/${id}/memory`),

  // Sessions
  getSessions: (agentId) => req('GET', `/sessions/${agentId}`),
  getSession: (agentId, sessId) => req('GET', `/sessions/${agentId}/${sessId}`),
  renameSession: (agentId, sessId, title) => req('PATCH', `/sessions/${agentId}/${sessId}`, { title }),
  deleteSession: (agentId, sessId) => req('DELETE', `/sessions/${agentId}/${sessId}`),
  searchSessions: (q, agentId) => req('GET', `/sessions/search?q=${encodeURIComponent(q)}${agentId ? `&agent_id=${agentId}` : ''}`),

  // Ollama (model management — pull/delete/info)
  getModels: () => req('GET', '/ollama/models'),
  getModelInfo: (name) => req('GET', `/ollama/models/${encodeURIComponent(name)}/info`),
  deleteModel: (name) => req('DELETE', `/ollama/models/${encodeURIComponent(name)}`),
  pullModel: () => `${BASE}/ollama/pull`, // returns SSE url; caller uses fetch + streams

  // Unified models across all providers (grouped: { ollama, anthropic, openai, gemini })
  getAllModels: () => req('GET', '/models'),
  testProvider: (provider) => req('GET', `/models/test/${encodeURIComponent(provider)}`),

  // Config
  getConfig: () => req('GET', '/config'),
  updateConfig: (data) => req('PUT', '/config', data),
  clearStoredSecrets: () => req('DELETE', '/config/secrets'),
  clearSharedBlackboard: () => req('DELETE', '/config/shared-blackboard'),

  // Pipelines
  getPipelines: () => req('GET', '/pipelines'),
  getPipeline: (id) => req('GET', `/pipelines/${id}`),
  createPipeline: (data) => req('POST', '/pipelines', data),
  updatePipeline: (id, data) => req('PUT', `/pipelines/${id}`, data),
  deletePipeline: (id) => req('DELETE', `/pipelines/${id}`),
  getPipelineRuns: (id) => req('GET', `/pipelines/${id}/runs`),
  clearPipelineRuns: (id) => req('DELETE', `/pipelines/${id}/runs`),
  clearAllPipelineRuns: () => req('DELETE', '/pipelines/runs/all'),

  // runPipeline streams SSE — caller uses the returned fetch Response directly
  runPipeline: (id, input, signal) =>
    fetch(`${BASE}/pipelines/${id}/run`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ input }),
      signal,
    }),

  // retryPipelineStep streams SSE for a single step retry
  retryPipelineStep: (id, step_index, prev_output, input, signal) =>
    fetch(`${BASE}/pipelines/${id}/run-step`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ step_index, prev_output, input }),
      signal,
    }),

  // Schedules
  getSchedules: () => req('GET', '/schedules'),
  getSchedule: (id) => req('GET', `/schedules/${id}`),
  createSchedule: (data) => req('POST', '/schedules', data),
  updateSchedule: (id, data) => req('PUT', `/schedules/${id}`, data),
  toggleSchedule: (id) => req('POST', `/schedules/${id}/toggle`),
  runScheduleNow: (id) => req('POST', `/schedules/${id}/run-now`),
  deleteSchedule: (id) => req('DELETE', `/schedules/${id}`),
  clearScheduleHistory: (id) => req('DELETE', `/schedules/${id}/history`),
  clearAllScheduleHistory: () => req('DELETE', '/schedules/history/all'),

  // Colony teams — a Colony is a named, persistent team; runs live under it.
  getColonyTeams: () => req('GET', '/colony/teams'),
  createColonyTeam: (data) => req('POST', '/colony/teams', data),
  getColonyTeam: (id) => req('GET', `/colony/teams/${id}`),
  updateColonyTeam: (id, data) => req('PUT', `/colony/teams/${id}`, data),
  deleteColonyTeam: (id) => req('DELETE', `/colony/teams/${id}`),
  getColonyTeamBoard: (id) => req('GET', `/colony/teams/${id}/board`),

  // Colony work queue — work flows to colonies as items (proposed → queued →
  // claimed); starting a queued item is the primary launch path.
  getTeamQueue: (id) => req('GET', `/colony/teams/${id}/queue`),
  addTeamQueueItem: (id, data) => req('POST', `/colony/teams/${id}/queue`, data),
  updateTeamQueueItem: (id, itemId, data) => req('PUT', `/colony/teams/${id}/queue/${itemId}`, data),
  deleteTeamQueueItem: (id, itemId) => req('DELETE', `/colony/teams/${id}/queue/${itemId}`),
  // Start streams SSE — caller consumes the fetch Response like launchColony
  startTeamQueueItem: (id, itemId, body, signal) =>
    fetch(`${BASE}/colony/teams/${id}/queue/${itemId}/start`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {}),
      signal,
    }),
  getUnroutedQueue: () => req('GET', '/colony/queue/unrouted'),
  updateQueueItem: (itemId, data) => req('PUT', `/colony/queue/${itemId}`, data),
  // Roster change hints (SSE) — refetch teams/queues on events
  streamColonyRoster: (signal) => fetch(`${BASE}/colony/roster/stream`, { method: 'GET', headers: authHeaders(), signal }),

  // Colony runs
  getColonies: () => req('GET', '/colony'),
  getColonyRecipes: () => req('GET', '/colony/recipes'),
  getColonyRepo: () => req('GET', '/colony/repo'),
  setColonyRepo: (repo_path) => req('PUT', '/colony/repo', { repo_path }),
  getColonyProjectBoard: () => req('GET', '/colony/project-board'),
  getColony: (id) => req('GET', `/colony/${id}`),
  getColonyArtifact: (id, path) => req('GET', `/colony/${id}/artifact?path=${encodeURIComponent(path)}`),
  // Direct URL to an artifact's raw bytes (for <img>/<audio> src and downloads).
  // The auth token rides as a query param since element src can't send headers.
  colonyArtifactRawUrl: (id, path, { download = false } = {}) => {
    const params = new URLSearchParams({ path, raw: '1' });
    if (download) params.set('download', '1');
    const token = getHiveAuthToken();
    if (token) params.set('hive_token', token);
    return `${BASE}/colony/${id}/artifact?${params.toString()}`;
  },
  stopColony: (id) => req('POST', `/colony/${id}/stop`),
  deleteColony: (id) => req('DELETE', `/colony/${id}`),
  // Communication protocol surfaces
  getColonyAgents: (id) => req('GET', `/colony/${id}/agents`),
  getColonyBlackboard: (id) => req('GET', `/colony/${id}/blackboard`),
  postColonyBlackboard: (id, body) => req('POST', `/colony/${id}/blackboard`, body),
  getColonyHandoffs: (id) => req('GET', `/colony/${id}/handoffs`),
  approveColonyHandoff: (id, handoffId, decision, note) =>
    req('POST', `/colony/${id}/handoffs/${handoffId}/approve`, { decision, note }),
  getRecipeFlow: (recipeId) => req('GET', `/colony/recipes/${recipeId}/flow`),
  // Colony launch returns an SSE stream — caller uses fetch directly
  launchColony: (goal, model, recipeId, opts = {}, signal) =>
    fetch(`${BASE}/colony`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        goal, model, recipe_id: recipeId,
        team_id: opts.teamId,
        repo_path: opts.repoPath, board_card: opts.boardCard,
        cloud_enabled: opts.cloudEnabled, model_plan: opts.modelPlan,
        trigger_config: opts.triggerConfig,
        github_writeback: opts.githubWriteback,
      }),
      signal,
    }),
  updateColonyTriggers: (id, triggerConfig) => req('PUT', `/colony/${id}/triggers`, { trigger_config: triggerConfig }),
  postColonyBoardComment: (id, body) => req('POST', `/colony/${id}/board/comment`, body ? { body } : {}),
  proposeColonyModels: (recipeId, cloudEnabled) => req('POST', '/colony/propose-models', { recipe_id: recipeId, cloud_enabled: cloudEnabled }),
  sendColonyDirection: (id, content, targetRole = null) => req('POST', `/colony/${id}/directions`, { content, target_role: targetRole }),
  acceptBootstrapTasks: (id, tasks) => req('POST', `/colony/${id}/bootstrap/accept`, tasks ? { tasks } : {}),
  // Resumable tail of an existing colony. Replays log entries from the DB
  // since=<seq> and then attaches to the live bus if the run is ongoing.
  streamColony: (id, since = 0, signal) =>
    fetch(`${BASE}/colony/${id}/stream?since=${since}`, { method: 'GET', headers: authHeaders(), signal }),

  // Staff
  getStaffProfiles: () => req('GET', '/staff/profiles'),
  getStaffProfile: (id) => req('GET', `/staff/profiles/${id}`),
  createStaffProfile: (data) => req('POST', '/staff/profiles', data),
  updateStaffProfile: (id, data) => req('PUT', `/staff/profiles/${id}`, data),
  deleteStaffProfile: (id) => req('DELETE', `/staff/profiles/${id}`),
  createAgentFromStaffProfile: (id, data = {}) => req('POST', `/staff/profiles/${id}/agent`, data),
  getStaffEffectiveConfig: (id) => req('GET', `/staff/profiles/${id}/effective`),
  resetStaffProfile: (id, fields) => req('POST', `/staff/profiles/${id}/reset`, fields ? { fields } : {}),
  syncStaffSuggestions: () => req('POST', '/staff/suggestions/sync'),
  applyStaffSuggestion: (id, proposed_value) => req('POST', `/staff/suggestions/${id}/apply`, proposed_value !== undefined ? { proposed_value } : {}),
  dismissStaffSuggestion: (id) => req('POST', `/staff/suggestions/${id}/dismiss`),

  // Skills catalog + tool options
  getSkills: () => req('GET', '/skills'),
  createSkill: (data) => req('POST', '/skills', data),
  updateSkill: (id, data) => req('PUT', `/skills/${id}`, data),
  deleteSkill: (id) => req('DELETE', `/skills/${id}`),
  getToolOptions: () => req('GET', '/skills/tool-options'),

  // System / Ollama process monitor
  getSystemStatus: () => req('GET', '/system/status'),
  getSystemMetrics: () => req('GET', '/system/metrics'),
  stopModel: (model) => req('POST', '/system/model/stop', { model }),
  startNgrok: () => req('POST', '/system/ngrok/start'),
  stopNgrok: () => req('POST', '/system/ngrok/stop'),
  getNgrokStatus: () => req('GET', '/system/ngrok/status'),

  // First-run setup wizard
  getSetupStatus: () => req('GET', '/system/setup'),
  completeSetup: () => req('POST', '/system/setup/complete'),

  // Sandbox
  getSandboxStatus: (agentId) => req('GET', `/sandbox/${agentId}`),
  startSandbox: (agentId) => req('POST', `/sandbox/${agentId}/start`),
  resetSandbox: (agentId) => req('POST', `/sandbox/${agentId}/reset`),
  getSandboxFiles: (agentId) => req('GET', `/sandbox/${agentId}/files`),
  getSandboxFile: (agentId, path) => req('GET', `/sandbox/${agentId}/file?path=${encodeURIComponent(path)}`),
  saveSandboxFile: (agentId, path, content) => req('PUT', `/sandbox/${agentId}/file?path=${encodeURIComponent(path)}`, { content }),

  // MCP servers
  getMcpServers: () => req('GET', '/mcp'),
  createMcpServer: (data) => req('POST', '/mcp', data),
  updateMcpServer: (id, data) => req('PUT', `/mcp/${id}`, data),
  deleteMcpServer: (id) => req('DELETE', `/mcp/${id}`),
  testMcpServer: (data) => req('POST', '/mcp/test', data),
  reconnectMcpServer: (id) => req('POST', `/mcp/${id}/reconnect`),

  // Webhooks
  getWebhooks: () => req('GET', '/webhooks'),
  createWebhook: (data) => req('POST', '/webhooks', data),
  updateWebhook: (id, data) => req('PUT', `/webhooks/${id}`, data),
  deleteWebhook: (id) => req('DELETE', `/webhooks/${id}`),
  getWebhookEvents: (id, type) => req('GET', `/webhooks/${id}/events${type ? `?type=${encodeURIComponent(type)}` : ''}`),
  getWebhookActionRuns: (id) => req('GET', `/webhooks/${id}/action-runs`),
  getProjectedEvent: (id, eventId) => req('GET', `/webhooks/${id}/events/${eventId}/projected`),
  clearWebhookEvents: (id) => req('DELETE', `/webhooks/${id}/events`),
};

// Derive ws/wss from the page protocol — a hardcoded ws:// is blocked as
// mixed content when the app is served over HTTPS (e.g. via ngrok).
export const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat`;
export function buildWebSocketUrl(agentId) {
  const token = getHiveAuthToken();
  const url = `${WS_URL}/${agentId}`;
  return token ? `${url}?hive_token=${encodeURIComponent(token)}` : url;
}
