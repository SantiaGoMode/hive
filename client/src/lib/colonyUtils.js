export const AGENT_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#06b6d4', '#ec4899', '#f97316', '#6366f1', '#84cc16'];

// ── SSE → log entries ─────────────────────────────────────────────────────────

export function sseToEntries(event, agentNameMap, now = Date.now()) {
  const entries = [];

  if (event.type === 'agent_ready') {
    agentNameMap[event.agent.id] = event.agent.name;
    entries.push({ type: 'agent_ready', agent: event.agent.name, role: event.role, ts: now });
    return entries;
  }
  if (event.type === 'round_start') {
    entries.push({ type: 'round', round: event.round, ts: now });
    return entries;
  }
  if (event.type === 'orchestrator_message') {
    entries.push({ type: 'message', agent: 'Orchestrator', content: event.content, ts: now });
    return entries;
  }
  if (event.type === 'done' || event.type === 'error') {
    entries.push({ type: event.type === 'error' ? 'error' : 'done', status: event.status, content: event.message, ts: now });
    return entries;
  }
  if (event.type === 'ws') {
    const msg = event.msg;
    if (msg.type === 'tool_call') {
      entries.push({ type: 'tool_call', agent: 'Orchestrator', tool: msg.name, args: msg.args, ts: now });
    }
    if (msg.type === 'tool_result') {
      entries.push({ type: 'tool_result', agent: 'Orchestrator', tool: msg.name, result: msg.result, ts: now });
    }
    if (msg.type === 'sub_tool_call') {
      const name = agentNameMap[msg.subAgent] || msg.subAgent || 'Worker';
      entries.push({ type: 'sub_tool_call', agent: name, tool: msg.name, args: msg.args, ts: now });
    }
    if (msg.type === 'sub_tool_result') {
      const name = agentNameMap[msg.subAgent] || msg.subAgent || 'Worker';
      entries.push({ type: 'tool_result', agent: name, tool: msg.name, result: msg.result, ts: now });
    }
  }
  return entries;
}

// ── Convert stored DB log entries → UI entries ─────────────────────────────────

export function dbLogToEntries(dbLog, agentColorMap) {
  const colorIdx = { current: Object.keys(agentColorMap).length };
  const map = { ...agentColorMap };

  return dbLog.map(e => {
    if (e.kind === 'agent_ready') {
      const name = e.agent?.name || e.role;
      if (name && !map[name]) {
        map[name] = AGENT_COLORS[colorIdx.current % AGENT_COLORS.length];
        colorIdx.current++;
      }
      return { type: 'agent_ready', agent: name, role: e.role, ts: e.ts };
    }
    if (e.kind === 'round') return { type: 'round', round: e.round, ts: e.ts };
    if (e.kind === 'message') return { type: 'message', agent: e.agent, content: e.content, ts: e.ts };
    if (e.kind === 'tool_call') return { type: 'tool_call', agent: e.agent, tool: e.tool, args: e.args, ts: e.ts };
    if (e.kind === 'tool_result') return { type: 'tool_result', agent: e.agent, tool: e.tool, result: e.result, ts: e.ts };
    if (e.kind === 'done') return { type: 'done', status: e.status, ts: e.ts };
    if (e.kind === 'error') return { type: 'error', content: e.message, ts: e.ts };
    return null;
  }).filter(Boolean);
}

// ── Merge tool_call + tool_result ─────────────────────────────────────────────

export function mergeToolEntries(log) {
  const merged = [];
  for (const entry of log) {
    if (entry.type === 'tool_result') {
      const last = [...merged].reverse().find(
        e => (e.type === 'tool_call' || e.type === 'sub_tool_call')
          && e.agent === entry.agent && e.tool === entry.tool && e.result === undefined
      );
      if (last) { last.result = entry.result; continue; }
    }
    merged.push({ ...entry });
  }
  return merged;
}
