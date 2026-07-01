// Single source of truth for the shared identity + memory scaffold that both the
// WebSocket chat loop (server/lib/websocket.js, runChatLoop) and the non-streaming
// agent tool-loop (server/lib/agentRunner.js, runAgentOnce) prepend to every system
// prompt (#30). Before this helper the two sites hand-assembled overlapping
// identity/memory text that could drift apart.
//
// The two call sites differ intentionally and the helper preserves those
// differences byte-for-byte via `mode`:
//   - mode 'chat'  (WebSocket): identity anchor includes a "hello" self-intro line
//     and a FORMATTING block; memory is labelled "[Your memory from previous
//     sessions]". The chat site appends its own shared-blackboard + tool sections
//     AFTER this scaffold.
//   - mode 'agent' (colony/pipeline/sub-agent): a leaner identity anchor with no
//     hello/formatting lines; memory is labelled "[Memory from previous sessions]".
//     The agent site uses this scaffold as the complete system prompt.
//
// This helper only owns the genuinely-shared identity + user-prompt + memory block.
// Anything context-specific (chat formatting extras live in the anchor here; shared
// blackboard and tool-catalogue guidance stay in websocket.js) is deliberately left
// to the caller so both sites keep producing exactly the prompt they produce today.

const DEFAULT_USER_PROMPT = 'Be helpful, direct, and concise.';

// Build the identity + memory system-prompt scaffold for `agent`.
//   agent    — parsed agent object ({ name, id, system_prompt, workspace, ... }).
//   mode     — 'chat' (WebSocket richer anchor) or 'agent' (leaner colony anchor).
//   agentId  — fallback name/id when agent.name is missing (chat passes the socket's
//              agentId; agent mode falls back to agent.id like the original code).
//   memory   — pre-read memory string (call sites already read it via their own
//              readMemory dependency, so we accept it rather than re-reading here).
function buildSystemPrompt(agent, { mode = 'chat', agentId = null, memory = '' } = {}) {
  const agentName = agent?.name || agentId || agent?.id;
  const userPrompt = agent?.system_prompt?.trim() || '';

  let identityAnchor;
  let memoryBlock;

  if (mode === 'chat') {
    identityAnchor =
      `You are ${agentName}, an AI assistant running in Hive.\n` +
      `Your name is ${agentName}. You are a Hive assistant.\n` +
      `If someone says "hello" or asks who you are, introduce yourself as a Hive assistant: ` +
      `"Hi! I'm ${agentName}, a Hive assistant. How can I help you?"\n` +
      `Do not identify yourself as any underlying model or company.\n\n` +
      `FORMATTING: Always use markdown to structure your responses. ` +
      `Use bullet points or numbered lists for multiple items, bold for key terms, ` +
      `headers for distinct sections, and code blocks for any code or commands. ` +
      `Never write long unbroken paragraphs — break ideas into readable chunks.\n\n`;

    memoryBlock = memory
      ? `\n\n---\n[Your memory from previous sessions]\n${memory}\n---`
      : '';

    return identityAnchor + (userPrompt || DEFAULT_USER_PROMPT) + memoryBlock;
  }

  // mode === 'agent'
  identityAnchor =
    `You are ${agentName}, an AI assistant running in Hive.\n` +
    `Your name is ${agentName}. You are a Hive assistant.\n` +
    `Do not identify yourself as any underlying model or company.\n\n`;

  memoryBlock = memory
    ? `\n\n---\n[Memory from previous sessions]\n${memory}\n---`
    : '';

  return identityAnchor + (userPrompt || DEFAULT_USER_PROMPT) + memoryBlock;
}

module.exports = { buildSystemPrompt, DEFAULT_USER_PROMPT };
