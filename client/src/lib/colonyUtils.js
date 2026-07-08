export const AGENT_COLORS = ['#d97706', '#0f766e', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#6366f1', '#84cc16'];

// ── SSE → log entries ─────────────────────────────────────────────────────────

export function sseToEntries(event, agentNameMap, now = Date.now()) {
  const entries = [];

  if (event.type === 'agent_ready') {
    agentNameMap[event.agent.id] = event.agent.name;
    entries.push({ type: 'agent_ready', agent: event.agent.name, role: event.role, agent_role: event.agent.persona_role || '', avatar_color: event.agent.avatar_color || null, model: event.agent.model || '', tools: event.agent.tools || [], ts: now });
    return entries;
  }
  if (event.type === 'round_start') {
    entries.push({ type: 'round', round: event.round, ts: now });
    return entries;
  }
  if (event.type === 'orchestrator_message') {
    entries.push({ type: 'message', agent: event.agent || 'Orchestrator', content: event.content, ts: now });
    return entries;
  }
  if (event.type === 'handoff' && event.handoff) {
    const h = event.handoff;
    entries.push({ type: 'handoff', from: h.from, to: h.to, contract: h.contract, status: h.status, requires_human: h.requires_human, ts: now });
    return entries;
  }
  if (event.type === 'protocol_violation') {
    entries.push({ type: 'protocol_violation', agent: event.agent, reason: event.reason, ts: now });
    return entries;
  }
  if (event.type === 'permission_required') {
    entries.push({ type: 'permission_required', agent: event.agent, tool: event.tool, message: event.message, ts: now });
    return entries;
  }
  if (event.type === 'thinking') {
    entries.push({ type: 'thinking', agent: event.agent, content: event.content || '', truncated: !!event.truncated, ts: now });
    return entries;
  }
  if (event.type === 'direction_queued' || event.type === 'direction_delivered') {
    entries.push({
      type: 'direction',
      status: event.type === 'direction_delivered' ? 'delivered' : 'queued',
      content: event.direction?.content || '',
      target_role: event.direction?.target_role || null,
      ts: now,
    });
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
      return { type: 'agent_ready', agent: name, role: e.role, agent_role: e.agent?.persona_role || '', avatar_color: e.agent?.avatar_color || null, model: e.agent?.model || '', tools: e.agent?.tools || [], ts: e.ts };
    }
    if (e.kind === 'preflight') return { type: 'system', message: e.message || 'Preflight check', ts: e.ts };
    if (e.kind === 'recipe') return { type: 'system', message: e.message || (e.name ? `Recipe: ${e.name}` : 'Recipe configured'), ts: e.ts };
    if (e.kind === 'round') return { type: 'round', round: e.round, ts: e.ts };
    if (e.kind === 'message') return { type: 'message', agent: e.agent, content: e.content, ts: e.ts };
    if (e.kind === 'thinking') return { type: 'thinking', agent: e.agent, content: e.content, truncated: !!e.truncated, ts: e.ts };
    if (e.kind === 'tool_call') return { type: 'tool_call', agent: e.agent, tool: e.tool, args: e.args, ts: e.ts };
    if (e.kind === 'tool_result') return { type: 'tool_result', agent: e.agent, tool: e.tool, result: e.result, ts: e.ts };
    if (e.kind === 'handoff') return { type: 'handoff', from: e.from, to: e.to, contract: e.contract, status: e.status, requires_human: e.requires_human, ts: e.ts };
    if (e.kind === 'protocol_violation') return { type: 'protocol_violation', agent: e.agent, reason: e.reason, ts: e.ts };
    if (e.kind === 'permission_required') return { type: 'permission_required', agent: e.agent, tool: e.tool, message: e.message, ts: e.ts };
    if (e.kind === 'direction') return { type: 'direction', status: e.status, content: e.content, target_role: e.target_role, ts: e.ts };
    if (e.kind === 'bootstrap') return { type: 'bootstrap', status: e.status, message: e.message, source: e.source, task_count: e.task_count, ts: e.ts };
    if (e.kind === 'checkpoint') return { type: 'checkpoint', agent: e.agent, ts: e.ts };
    if (e.kind === 'blackboard') return { type: 'blackboard', agent: e.agent, entry_type: e.entry_type, ts: e.ts };
    if (e.kind === 'writeback') return { type: 'system', message: e.message, ts: e.ts };
    if (e.kind === 'outcome') return { type: 'system', message: e.message, ts: e.ts };
    if (e.kind === 'sandbox_cleanup') return { type: 'system', message: e.message, ts: e.ts };
    if (e.kind === 'done') return { type: 'done', status: e.status, ts: e.ts };
    if (e.kind === 'error') return { type: 'error', content: e.message, ts: e.ts };
    // Blockers are surfaced in the amber panel (derived separately), not the log stream.
    if (e.kind === 'blocker') return null;
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
