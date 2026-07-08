// Rolling conversation sessions for bridge personas (Steward per channel,
// Operator per colony thread). History persists as a normal Hive session
// (JSONL in the agent's workspace) so the web UI can inspect the same
// conversation; the active session id per conversation key lives in
// app_settings. A session rolls over after 24h idle or an explicit reset.
const db = require('../../db');
const { saveSession, newSessionId } = require('../sessionWriter');
const { getSession } = require('../sessionReader');
const { logSwallowed } = require('../logSwallowed');

const IDLE_ROLLOVER_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 40; // context bound per turn

// conversation key → { sessionId, messages, lastAt }
const live = new Map();

function settingKey(key) {
  return `discord_session_${key}`;
}

function loadPersisted(agentId, key) {
  try {
    const sessionId = db.prepare('SELECT value FROM app_settings WHERE key=?').get(settingKey(key))?.value;
    if (!sessionId) return null;
    const session = getSession(agentId, sessionId);
    if (!session) return null;
    const messages = session.messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content }));
    return { sessionId, messages, lastAt: session.modified_at || Date.now() };
  } catch (e) {
    logSwallowed('discordSessions:load', e, { key });
    return null;
  }
}

function getConversation(agentId, key) {
  let convo = live.get(key) || loadPersisted(agentId, key);
  if (!convo || Date.now() - convo.lastAt > IDLE_ROLLOVER_MS) {
    convo = { sessionId: newSessionId(), messages: [], lastAt: Date.now() };
  }
  live.set(key, convo);
  return convo;
}

function appendTurn(agentId, key, userContent, assistantContent) {
  const convo = getConversation(agentId, key);
  convo.messages.push({ role: 'user', content: userContent, timestamp: Date.now() });
  convo.messages.push({ role: 'assistant', content: assistantContent, timestamp: Date.now() });
  if (convo.messages.length > MAX_HISTORY_MESSAGES * 2) {
    convo.messages = convo.messages.slice(-MAX_HISTORY_MESSAGES * 2);
  }
  convo.lastAt = Date.now();
  try {
    saveSession(agentId, convo.sessionId, convo.messages);
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run(settingKey(key), convo.sessionId);
  } catch (e) {
    logSwallowed('discordSessions:save', e, { key });
  }
}

// History to send to the model this turn: prior messages plus the new user one.
function historyFor(agentId, key, userContent) {
  const convo = getConversation(agentId, key);
  return [
    ...convo.messages.slice(-MAX_HISTORY_MESSAGES).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];
}

function resetConversation(key) {
  live.delete(key);
  try {
    db.prepare('DELETE FROM app_settings WHERE key=?').run(settingKey(key));
  } catch (e) {
    logSwallowed('discordSessions:reset', e, { key });
  }
}

module.exports = { getConversation, historyFor, appendTurn, resetConversation, IDLE_ROLLOVER_MS };
