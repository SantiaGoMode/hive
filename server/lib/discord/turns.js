// Shared one-turn engine for the bridge personas (Steward, Colony Operator,
// health triage). Wraps runAgentOnce with: rolling session history, a tool-call
// collector (for the compact 🛠 footer), and optional per-turn system-prompt
// augmentation (team snapshots, finding evidence) that never persists to the
// agent row.
const { readAgent, touchAgent } = require('../agentParser');
const { runAgentOnce } = require('../agentRunner');
const { getOllamaUrl } = require('../ollamaUrl');
const config = require('../config');
const sessions = require('./sessions');

async function personaTurn({
  agentId,
  conversationKey,
  userContent,
  tools = null,           // toolsOverride for runAgentOnce (null → agent's own)
  maxRounds = 12,
  systemSuffix = '',      // ephemeral context appended to the system prompt
  colonyContext = null,   // threaded through to tool handlers
}) {
  const agent = readAgent(agentId);
  if (!agent) throw new Error('Bridge agent missing — restart Hive to reseed it.');
  if (!agent.model) {
    throw new Error(`"${agent.name}" has no model configured. Set one on the Staff page in the Hive UI (model preference).`);
  }

  const toolCalls = [];
  const wsCollector = {
    OPEN: 1,
    readyState: 1,
    send(payload) {
      try {
        const ev = JSON.parse(payload);
        if (ev.type === 'sub_tool_call' && ev.name) toolCalls.push(ev.name);
      } catch { /* collector only cares about well-formed events */ }
    },
  };

  const effectiveAgent = systemSuffix
    ? { ...agent, system_prompt: `${agent.system_prompt || ''}\n\n${systemSuffix}`.trim() }
    : agent;

  const messages = sessions.historyFor(agentId, conversationKey, userContent);
  const output = await runAgentOnce(
    effectiveAgent,
    messages,
    getOllamaUrl(),
    0,
    wsCollector,
    config.hiveHome(),
    tools,
    maxRounds,
    null,
    colonyContext,
  );
  sessions.appendTurn(agentId, conversationKey, userContent, output || '(no response)');
  try { touchAgent(agentId); } catch { /* freshness stamp is best-effort */ }
  return { text: output || '(no response)', toolCalls };
}

module.exports = { personaTurn };
