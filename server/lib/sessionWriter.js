const fs   = require('fs');
const path = require('path');
const { readAgent } = require('./agentParser');

function getSessionsDir(agentId) {
  const agent = readAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.workspace) throw new Error(`Agent ${agentId} has no workspace configured`);

  const dir = path.join(agent.workspace, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Write (or overwrite) a session JSONL file with the given messages array.
// Each message is one JSON line: { role, content, toolEvents?, timestamp }
function saveSession(agentId, sessionId, messages) {
  const file = path.join(getSessionsDir(agentId), `${sessionId}.jsonl`);
  const lines = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => JSON.stringify({
      role:       m.role,
      content:    m.content || '',
      ...(m.toolEvents?.length ? { tool_calls: m.toolEvents.map(te => ({ name: te.name })) } : {}),
      timestamp:  m.timestamp || Date.now(),
    }))
    .join('\n');
  fs.writeFileSync(file, lines + '\n', 'utf8');
}

function newSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = { saveSession, newSessionId, getSessionsDir };
