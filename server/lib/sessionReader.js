const fs   = require('fs');
const path = require('path');
const { readAgent, listAgents } = require('./agentParser');
const db = require('../db');
const { logSwallowed } = require('./logSwallowed');

function getSessionsDir(agentId) {
  const agent = readAgent(agentId);
  if (!agent?.workspace) return null;
  return path.join(agent.workspace, 'sessions');
}

// Normalize a raw JSONL line into {role, content, tool_calls, timestamp}.
// Handles both Hive's simple format and legacy event-based formats.
function normalizeLine(raw) {
  try {
    const obj = JSON.parse(raw);

    // Legacy event format: {"type":"message","message":{"role":"user","content":[...]}}
    if (obj.type === 'message' && obj.message) {
      const m = obj.message;
      let content = '';
      let tool_calls = [];
      if (typeof m.content === 'string') {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text')     content += block.text || '';
          if (block.type === 'toolCall') tool_calls.push(block);
        }
      }
      const normalRole = m.role === 'toolResult' ? 'tool' : m.role;
      return { role: normalRole, content, tool_calls: tool_calls.length ? tool_calls : undefined, timestamp: new Date(obj.timestamp).getTime() };
    }

    // Simple format: {role, content, ...}
    if (obj.role && typeof obj.content === 'string') return obj;
  } catch (e) { logSwallowed('sessionReader:parseLine', e); }
  return null;
}

function listSessions(agentId) {
  const dir = getSessionsDir(agentId);
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  return files.map(file => {
    const sessId = file.replace('.jsonl', '');
    const stat = fs.statSync(path.join(dir, file));
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean);
    const messages = lines.map(normalizeLine).filter(Boolean);
    const userMsgs = messages.filter(m => m.role === 'user');
    const toolsUsed = [...new Set(messages.flatMap(m => (m.tool_calls || []).map(t => t.name)).filter(Boolean))];
    const firstUser = userMsgs[0]?.content || '';
    const preview   = firstUser.length > 60 ? firstUser.slice(0, 60).trimEnd() + '…' : firstUser;
    const meta = db.prepare('SELECT title FROM sessions_meta WHERE agent_id = ? AND session_id = ?').get(agentId, sessId);
    return {
      id: sessId,
      agent_id: agentId,
      title: meta?.title || null,
      preview,
      message_count: messages.length,
      user_message_count: userMsgs.length,
      tools_used: toolsUsed,
      created_at: stat.birthtimeMs || stat.ctimeMs,
      modified_at: stat.mtimeMs,
    };
  }).sort((a, b) => b.modified_at - a.modified_at);
}

function getSession(agentId, sessId) {
  const dir = getSessionsDir(agentId);
  if (!dir) return null;
  const file = path.join(dir, `${sessId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const lines    = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const messages = lines.map(normalizeLine).filter(Boolean);
  const stat     = fs.statSync(file);
  return {
    id: sessId,
    agent_id: agentId,
    messages,
    message_count: messages.length,
    created_at: stat.birthtimeMs || stat.ctimeMs,
    modified_at: stat.mtimeMs,
  };
}

function deleteSession(agentId, sessId) {
  const dir = getSessionsDir(agentId);
  if (!dir) return;
  const file = path.join(dir, `${sessId}.jsonl`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function searchSessions(query, agentId) {
  const q = query.toLowerCase();
  const agentIds = agentId ? [agentId] : listAgents().map(a => a.id);
  const results = [];
  for (const aid of agentIds) {
    const sessions = listSessions(aid);
    for (const sess of sessions) {
      const full = getSession(aid, sess.id);
      if (!full) continue;
      const matches = full.messages.filter(m => m.content?.toLowerCase().includes(q));
      if (matches.length > 0) results.push({ ...sess, matches });
    }
  }
  return results;
}

module.exports = { listSessions, getSession, deleteSession, searchSessions };
