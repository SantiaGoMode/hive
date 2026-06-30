const { WebSocketServer } = require('ws');
const db = require('../db');
const { readAgent, touchAgent, stripProviderPrefix } = require('./agentParser');
const { saveSession, newSessionId } = require('./sessionWriter');
const { getToolDefinitions, executeTool, readMemory, readShared } = require('./agentTools');
const mcpManager = require('./mcpClient');
const activity = require('./activityTracker');
const providers = require('./providers');
const { getOllamaUrl } = require('./ollamaUrl');
const { hasValidAuth, isAllowedOrigin, rejectSocket } = require('./auth');

const MAX_TOOL_ROUNDS = 10;

// Real collaborators, grouped so tests can inject fakes via runChatLoop's `deps`
// argument without a wider refactor. Production never passes `deps`, so these
// defaults are used unchanged.
const DEFAULT_DEPS = {
  readAgent, getToolDefinitions, executeTool, saveSession, newSessionId,
  readMemory, readShared, getOllamaUrl, mcpManager, activity,
  streamChat: (model, opts) => providers.streamChat(model, opts),
};

// Stream one model round through the provider layer (Ollama or a cloud provider,
// routed by the model id prefix). Sends {type:'chunk'} events to ws as visible
// text arrives, and returns { text, toolCalls, doneReason, stats } for the loop.
// Reasoning ("thinking") deltas are streamed with kind:'thinking' so the UI can
// surface them separately; they are not part of the saved visible text.
async function streamRound(ws, messages, model, tools, signal, options = {}, streamChat = DEFAULT_DEPS.streamChat) {
  let text = '';
  const toolCalls = [];
  let doneReason = 'stop';
  let stats = null;

  for await (const ev of streamChat(model, { messages, tools, options, signal })) {
    if (ev.type === 'content') {
      text += ev.delta;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'chunk', content: ev.delta }));
    } else if (ev.type === 'thinking') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'chunk', content: ev.delta, kind: 'thinking' }));
    } else if (ev.type === 'tool_call') {
      toolCalls.push(ev.call);
    } else if (ev.type === 'done') {
      doneReason = ev.reason || 'stop';
      stats = ev.stats;
    }
  }

  return { text, toolCalls, doneReason, stats };
}

function toSessionContent(content) {
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
  }
  return content || '';
}

function buildSaveableMessages(clientMessages, assistantText, timestamp = Date.now()) {
  return [
    ...clientMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role,
        content: toSessionContent(m.content),
        timestamp,
      })),
    { role: 'assistant', content: assistantText, timestamp },
  ];
}

async function runChatLoop(ws, agentId, clientMessages, model, sessionId, deps = {}) {
  const {
    readAgent, getToolDefinitions, executeTool, saveSession, newSessionId,
    readMemory, readShared, getOllamaUrl, mcpManager, activity, streamChat,
  } = { ...DEFAULT_DEPS, ...deps };

  const agent = readAgent(agentId);
  const ollamaUrl = getOllamaUrl();

  const numPredict = agent?.max_tokens    ?? 4096;
  const numCtx     = agent?.context_length ?? 8192;

  const inferenceOptions = {
    temperature: agent?.temperature ?? 0.7,
    num_predict: numPredict,
    // num_ctx is the TOTAL context window (input + output). If it's smaller than
    // num_predict, Ollama silently caps output at (num_ctx - input_tokens).
    // Always ensure num_ctx is large enough to fit the requested output plus
    // a generous input budget (4k tokens for system prompt + conversation history).
    num_ctx: Math.max(numCtx, numPredict + 4096),
    // Spend attribution for gateway calls (logged per request).
    metadata: { agent_id: agentId, agent_name: agent?.name || agentId, session: sessionId || '', source: 'chat' },
  };

  // Build tool list based on which tool groups the agent has enabled
  const tools = getToolDefinitions(agent?.tools || []);

  // Build system prompt
  const agentName  = agent?.name || agentId;
  const userPrompt = agent?.system_prompt?.trim() || '';

  const identityAnchor =
    `You are ${agentName}, an AI assistant running in Hive.\n` +
    `Your name is ${agentName}. You are a Hive assistant.\n` +
    `If someone says "hello" or asks who you are, introduce yourself as a Hive assistant: ` +
    `"Hi! I'm ${agentName}, a Hive assistant. How can I help you?"\n` +
    `Do not identify yourself as any underlying model or company.\n\n` +
    `FORMATTING: Always use markdown to structure your responses. ` +
    `Use bullet points or numbered lists for multiple items, bold for key terms, ` +
    `headers for distinct sections, and code blocks for any code or commands. ` +
    `Never write long unbroken paragraphs — break ideas into readable chunks.\n\n`;

  // Inject persistent memory and shared blackboard
  const memory = readMemory(agent?.workspace);
  const shared = readShared(null); // null → uses ~/.hive/shared/SHARED.md

  const memoryBlock = memory
    ? `\n\n---\n[Your memory from previous sessions]\n${memory}\n---`
    : '';
  const sharedBlock = shared
    ? `\n\n---\n[Shared blackboard — notes left by other agents]\n${shared}\n---`
    : '';

  const basePrompt = identityAnchor + (userPrompt || `Be helpful, direct, and concise.`) + memoryBlock + sharedBlock;

  const enabledGroups = agent?.tools || [];
  const toolDescriptions = [];
  if (enabledGroups.includes('agent_tools')) toolDescriptions.push('agent management, collaboration, pipelines, and schedules (list/create/update/delete agents; ask another agent a question; create and run pipelines; create, delete, and toggle scheduled runs)');
  if (enabledGroups.includes('web_search'))  toolDescriptions.push('web search and page fetching (use for current events, recent facts, or anything that may have changed since your training)');
  if (enabledGroups.includes('memory'))      toolDescriptions.push('persistent memory (save_memory — call this to remember things across sessions)');

  // MCP server context — resolve connected servers and their tool lists
  const mcpServerIds = enabledGroups.filter(g => g.startsWith('mcp:')).map(g => g.slice(4));
  const mcpEntries   = mcpServerIds.map(id => mcpManager.clients.get(id)).filter(Boolean);

  const toolLines = [];
  if (toolDescriptions.length > 0 || mcpEntries.length > 0) {
    const allDesc = [...toolDescriptions];
    for (const e of mcpEntries) {
      allDesc.push(`${e.server.name} (MCP server: ${e.tools.length} tools)`);
    }
    toolLines.push(`\n\nYou have access to the following tools: ${allDesc.join('; ')}.`);
  }
  if (enabledGroups.includes('web_search')) {
    toolLines.push(
      `For any question about current events, today's news, recent facts, live data, or anything that may have changed since your training cutoff, you MUST call web_search — do not guess or answer from memory.`,
      `Use web_fetch to read a specific page when the URL is known or returned by a search.`,
    );
  }
  if (enabledGroups.includes('agent_tools')) {
    toolLines.push(
      `Use agent management tools when the request involves creating, editing, or delegating to another agent. ` +
      `Use list_pipelines / create_pipeline / run_pipeline to manage multi-step agent pipelines. ` +
      `Use list_schedules / create_schedule / delete_schedule / toggle_schedule to manage scheduled agent runs.`,
    );
  }
  if (enabledGroups.includes('memory')) {
    toolLines.push(`Use save_memory proactively: whenever the user shares their name, preferences, goals, or anything they'd want you to recall next time — save it. Rewrite the full memory each time so it stays organized.`);
  }
  // Inject full MCP tool catalogue so the model knows exactly what's available
  if (mcpEntries.length > 0) {
    const mcpBlock = mcpEntries.map(e => {
      const toolList = e.tools.map(t =>
        `  - \`${e.server.id}__${t.name}\`: ${t.description || '(no description)'}`
      ).join('\n');
      return `**${e.server.name}** (call tools as \`${e.server.id}__<toolName>\`):\n${toolList}`;
    }).join('\n\n');
    toolLines.push(
      `\n\nYou have access to the following MCP (external) tools — use them proactively whenever the user's request can be served by them:\n\n${mcpBlock}`,
    );
  }
  if (toolLines.length > 0) {
    toolLines.push(`\nFor general knowledge, opinions, or anything you can answer confidently from your own training, answer directly without calling any tool.`);
  }
  const toolNote = toolLines.join(' ');

  const systemContent = basePrompt + toolNote;

  const messages = [
    { role: 'system', content: systemContent },
    ...clientMessages,
  ];

  const activeSessionId = sessionId || newSessionId();
  const ctrl = new AbortController();
  ws._abortCtrl = ctrl;

  activity.setActive(agentId);
  try {
    let completed = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { text, toolCalls, doneReason, stats } = await streamRound(
        ws, messages, model, tools, ctrl.signal, inferenceOptions, streamChat,
      );

      const assistantMsg = { role: 'assistant', content: text };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);

      if (!toolCalls.length) {
        // Emit generation stats before done so client can show tok/s
        if (stats && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'stats', ...stats }));
        }

        // Save session: clientMessages is the clean prior history (user+assistant only,
        // no tool intermediates). Append the final assistant response as the last entry.
        let savedSession = false;
        try {
          const saveable = buildSaveableMessages(clientMessages, text);
          saveSession(agentId, activeSessionId, saveable);
          savedSession = true;
        } catch (err) {
          console.error('[hive] failed to save chat session', {
            agentId,
            sessionId: activeSessionId,
            error: err.message,
          });
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'session_save_error',
              message: 'Response generated, but Hive could not save it to chat history.',
              detail: err.message,
            }));
          }
        }

        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'done',
            truncated: doneReason === 'length',
            ...(savedSession ? { sessionId: activeSessionId } : {}),
          }));
        }
        completed = true;
        break;
      }

      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'done_partial' }));

      for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        const rawArgs  = tc.function?.arguments ?? {};
        const toolArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

        if (ws.readyState === ws.OPEN) {
          const serverName = mcpManager.isMcpTool(toolName) ? mcpManager.getServerName(toolName) : null;
          ws.send(JSON.stringify({ type: 'tool_call', name: toolName, args: toolArgs, serverName }));
        }

        const result = await executeTool(toolName, toolArgs, agentId, ollamaUrl, 0, agent?.workspace, null, ws);

        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'tool_result', name: toolName, result }));
        }

        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id, name: toolName });
      }
    }

    // Exhausted MAX_TOOL_ROUNDS without a final (tool-free) answer. Without this
    // the client would hang forever waiting on a `done` that never comes.
    if (!completed && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: `Stopped after ${MAX_TOOL_ROUNDS} tool-call rounds without a final answer.`,
      }));
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'stopped' }));
    } else {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  } finally {
    ws._abortCtrl = null;
    activity.setIdle(agentId);
  }
}

function createWebSocketServer(server, authOptions = {}) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/ws/chat')) {
      if (!isAllowedOrigin(req.headers.origin, authOptions)) {
        return rejectSocket(socket, 403, 'Origin is not allowed');
      }
      if (!hasValidAuth(req, authOptions)) {
        return rejectSocket(socket, 401, 'Hive authentication is required');
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    const url     = new URL(req.url, 'http://localhost');
    const agentId = url.pathname.split('/').pop();

    ws.on('message', async (data) => {
      let payload;
      try { payload = JSON.parse(data); } catch { return; }

      if (payload.type === 'stop') {
        if (ws._abortCtrl) { ws._abortCtrl.abort(); ws._abortCtrl = null; }
        return;
      }

      if (payload.type === 'chat') {
        touchAgent(agentId);
        const model = stripProviderPrefix(payload.model || readAgent(agentId)?.model);
        if (!model) {
          ws.send(JSON.stringify({ type: 'error', message: 'No model configured for this agent' }));
          return;
        }
        await runChatLoop(ws, agentId, payload.messages, model, payload.sessionId || null);
      }
    });

    ws.on('close', () => {
      if (ws._abortCtrl) { ws._abortCtrl.abort(); ws._abortCtrl = null; }
    });
  });

  return wss;
}

module.exports = { createWebSocketServer, buildSaveableMessages, runChatLoop, streamRound, MAX_TOOL_ROUNDS };
