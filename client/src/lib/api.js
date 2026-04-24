const BASE = '/api';

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
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

  // Ollama
  getModels: () => req('GET', '/ollama/models'),
  getModelInfo: (name) => req('GET', `/ollama/models/${encodeURIComponent(name)}/info`),
  deleteModel: (name) => req('DELETE', `/ollama/models/${encodeURIComponent(name)}`),
  pullModel: (name) => `${BASE}/ollama/pull`, // returns SSE url; caller uses fetch + streams

  // Config
  getConfig: () => req('GET', '/config'),
  updateConfig: (data) => req('PUT', '/config', data),
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal,
    }),

  // retryPipelineStep streams SSE for a single step retry
  retryPipelineStep: (id, step_index, prev_output, input, signal) =>
    fetch(`${BASE}/pipelines/${id}/run-step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  // Colony
  getColonies: () => req('GET', '/colony'),
  getColony: (id) => req('GET', `/colony/${id}`),
  stopColony: (id) => req('POST', `/colony/${id}/stop`),
  deleteColony: (id) => req('DELETE', `/colony/${id}`),
  // Colony launch returns an SSE stream — caller uses fetch directly
  launchColony: (goal, model) =>
    fetch(`${BASE}/colony`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, model }),
    }),
  // Resumable tail of an existing colony. Replays log entries from the DB
  // since=<seq> and then attaches to the live bus if the run is ongoing.
  streamColony: (id, since = 0, signal) =>
    fetch(`${BASE}/colony/${id}/stream?since=${since}`, { method: 'GET', signal }),

  // System / Ollama process monitor
  getSystemStatus: () => req('GET', '/system/status'),
  stopModel: (model) => req('POST', '/system/model/stop', { model }),

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
};

export const WS_URL = `ws://${location.host}/ws/chat`;
