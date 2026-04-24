const fs   = require('fs');
const path = require('path');
const { listAgents, readAgent, writeAgent, deleteAgent, stripProviderPrefix } = require('./agentParser');
const mcpManager = require('./mcpClient');
const db = require('../db');

// ── Shared blackboard ─────────────────────────────────────────────────────────
// A single SHARED.md file all agents can read and write.

function getSharedPath(hivePath) {
  const base = hivePath || path.join(require('os').homedir(), '.hive');
  return path.join(base, 'shared', 'SHARED.md');
}

function readShared(hivePath) {
  const p = getSharedPath(hivePath);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').trim();
}

function writeShared(content, hivePath) {
  const p = getSharedPath(hivePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content.trimEnd() + '\n', 'utf8');
}

// ── Memory helpers ────────────────────────────────────────────────────────────

function readMemory(workspace) {
  if (!workspace) return '';
  const p = path.join(workspace, 'MEMORY.md');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').trim();
}

// ── Non-streaming agent loop (used by ask_agent) ──────────────────────────────
// Runs the full tool loop for a target agent without a WebSocket, so the calling
// agent gets a real answer even if the target needs to call tools (e.g. web search).

const MAX_SUB_ROUNDS = 6;

// ── Text tool call parser ─────────────────────────────────────────────────────
// Some models (llama3.1, mistral-7b) describe tool calls in markdown/JSON prose
// instead of emitting proper function_call payloads. This parser extracts those
// descriptions and returns synthetic tool_calls so the agent loop can execute them.
//
// Patterns handled:
//   {"name": "tool_name", "parameters": {...}}
//   {"name": "tool_name", "arguments": {...}}
//   Same patterns inside ```json ... ``` code blocks
function extractTextToolCalls(content, toolDefinitions) {
  const toolNames = new Set(
    toolDefinitions.map(t => t.function?.name).filter(Boolean),
  );
  if (toolNames.size === 0) return [];

  const candidates = [];

  // 1. Code blocks: ```json\n{...}\n```  or  ```\n{...}\n```
  const codeBlockRe = /```(?:json)?\s*(\{[\s\S]+?\})\s*```/g;
  let m;
  while ((m = codeBlockRe.exec(content)) !== null) candidates.push(m[1]);

  // 2. Bare JSON objects containing "name" + "parameters"/"arguments"
  // We scan for objects by finding every '{' that could be the start of one.
  const bareRe = /\{[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*(?:"parameters"|"arguments")\s*:\s*(\{)/g;
  while ((m = bareRe.exec(content)) !== null) {
    // Walk forward to find the matching closing brace for the inner args object,
    // then capture the full outer object.
    let start = m.index;
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') { depth--; if (depth === 0) { candidates.push(content.slice(start, i + 1)); break; } }
    }
  }

  const results = [];
  const seen = new Set();

  for (const raw of candidates) {
    let obj;
    try { obj = JSON.parse(raw); } catch {
      // Try fixing Python-style single quotes
      try { obj = JSON.parse(raw.replace(/'/g, '"')); } catch { continue; }
    }
    if (typeof obj.name !== 'string' || !toolNames.has(obj.name)) continue;
    const args = obj.parameters || obj.arguments || {};
    const key = obj.name + JSON.stringify(args);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ function: { name: obj.name, arguments: args } });
  }

  return results;
}

async function runAgentOnce(targetAgent, userMessages, ollamaUrl, depth, ws = null, hivePath = null, toolsOverride = null, maxRounds = MAX_SUB_ROUNDS, signal = null, colonyContext = null) {
  const agentName = targetAgent.name || targetAgent.id;

  // Build target's system prompt with identity + memory
  const memory    = readMemory(targetAgent.workspace);
  const memBlock  = memory
    ? `\n\n---\n[Memory from previous sessions]\n${memory}\n---`
    : '';
  const userPrompt = targetAgent.system_prompt?.trim() || 'Be helpful, direct, and concise.';
  const systemContent =
    `You are ${agentName}, an AI assistant running in Hive.\n` +
    `Your name is ${agentName}. You are a Hive assistant.\n` +
    `Do not identify yourself as any underlying model or company.\n\n` +
    userPrompt + memBlock;

  // toolsOverride (non-empty array) lets callers (pipeline steps, schedules) supply
  // a specific tool list that takes precedence over the agent's own configuration.
  const effectiveTools = (toolsOverride?.length > 0) ? toolsOverride : (targetAgent.tools || []);
  const targetTools = effectiveTools.length > 0 ? getToolDefinitions(effectiveTools) : [];

  const messages = [{ role: 'system', content: systemContent }, ...userMessages];

  // Detect worker tool-call loops: if the same tool+args is called 3+ times
  // consecutively the worker is stuck (e.g. retrying a successful pip install
  // because it misreads a WARNING as failure). Break the loop with an error.
  let lastCallKey = null;
  let consecutiveRepeats = 0;

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error('Colony run was stopped');

    const modelName = stripProviderPrefix(targetAgent.model).toLowerCase();
    // Only send think:true for models that support extended reasoning.
    // Sending it to other models (llama3.1, mistral, etc.) returns HTTP 400.
    const supportsThinking = /qwen3|deepseek-r1|phi4-reasoning/.test(modelName);
    const body = {
      model:  stripProviderPrefix(targetAgent.model),
      messages,
      stream: true,
      ...(supportsThinking ? { think: true } : {}),
    };
    if (targetTools.length > 0) body.tools = targetTools;

    let res;
    try {
      res = await fetch(`${ollamaUrl}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') throw fetchErr;
      const code = fetchErr.cause?.code;
      const model = stripProviderPrefix(targetAgent.model);
      if (code === 'ECONNREFUSED') {
        throw new Error(`Ollama is not running (ECONNREFUSED). Start Ollama and try again.`);
      } else if (code === 'ECONNRESET') {
        throw new Error(`Ollama closed the connection while running "${model}" — the model likely ran out of memory. Try switching to a smaller model (e.g. qwen3.5 or llama3.1:8b).`);
      } else if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
        throw new Error(`Ollama timed out running "${model}" — the model may be too large or slow. Try a smaller model.`);
      } else {
        throw new Error(`Ollama request failed for "${model}": ${fetchErr.message}. The model may have crashed or run out of memory — try a smaller model.`);
      }
    }

    if (!res.ok) {
      const model = stripProviderPrefix(targetAgent.model);
      if (res.status === 404) {
        throw new Error(`Model "${model}" not found on Ollama. Pull it first with: ollama pull ${model}`);
      }
      throw new Error(`Ollama error ${res.status} for model "${model}"`);
    }

    // Stream NDJSON chunks from Ollama and accumulate into a synthetic message.
    // Each chunk has shape { message: { content?, thinking?, tool_calls? }, done }.
    // We publish token deltas to the WS so the UI can render them live, and
    // accumulate the final content + tool_calls for the tool loop below.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const acc = { content: '', thinking: '', tool_calls: null };

    const handleChunk = (chunk) => {
      const m = chunk.message || {};
      if (typeof m.content === 'string' && m.content.length > 0) {
        acc.content += m.content;
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'token', subAgent: agentName, delta: m.content, kind: 'content' }));
        }
      }
      if (typeof m.thinking === 'string' && m.thinking.length > 0) {
        acc.thinking += m.thinking;
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'token', subAgent: agentName, delta: m.thinking, kind: 'thinking' }));
        }
      }
      if (m.tool_calls?.length) {
        acc.tool_calls = m.tool_calls;
      }
    };

    try {
      while (true) {
        if (signal?.aborted) throw new Error('Colony run was stopped');
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { handleChunk(JSON.parse(line)); } catch {}
        }
      }
      // Flush any trailing chunk without a newline (test server sends a single
      // JSON blob + stream close, with no terminating \n).
      const tail = buf.trim();
      if (tail) {
        try { handleChunk(JSON.parse(tail)); } catch {}
      }
    } catch (streamErr) {
      if (streamErr.name === 'AbortError' || streamErr.message === 'Colony run was stopped') throw streamErr;
      throw new Error(`Ollama stream failed: ${streamErr.message}`);
    }

    // If the model didn't emit proper tool_calls but wrote JSON tool descriptions
    // in its text (common with llama3.1, mistral, and other 7-8B models), parse
    // them out and execute them as if they were real tool calls.
    const syntacticToolCalls = (!acc.tool_calls?.length && acc.content && targetTools.length > 0)
      ? extractTextToolCalls(acc.content, targetTools)
      : [];
    if (syntacticToolCalls.length > 0) acc.tool_calls = syntacticToolCalls;

    const msg = {
      content: acc.content,
      ...(acc.thinking ? { thinking: acc.thinking } : {}),
      ...(acc.tool_calls ? { tool_calls: acc.tool_calls } : {}),
    };

    messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });

    if (!msg.tool_calls?.length) {
      return msg.content || '(no response)';
    }

    // Execute each tool call and append results
    for (const tc of msg.tool_calls) {
      if (signal?.aborted) throw new Error('Colony run was stopped');

      const toolName = tc.function?.name;
      const rawArgs  = tc.function?.arguments ?? {};
      let args;
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); } catch {
          // Python-style single quotes (llama3.1 quirk)
          try { args = JSON.parse(rawArgs.replace(/'/g, '"')); } catch { args = {}; }
        }
      } else {
        args = rawArgs;
      }

      // Loop detection: same tool + same args called 3 consecutive times → stuck.
      const callKey = toolName + '|' + JSON.stringify(args);
      if (callKey === lastCallKey) {
        consecutiveRepeats++;
      } else {
        lastCallKey = callKey;
        consecutiveRepeats = 1;
      }

      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'sub_tool_call', subAgent: agentName, name: toolName, args }));
      }

      let result;
      if (consecutiveRepeats >= 3) {
        result = {
          error: `Duplicate call detected: "${toolName}" has been called with identical arguments ${consecutiveRepeats} times in a row. The previous call likely succeeded (check the prior result). Stop retrying this operation and move on to the next task.`,
        };
      } else {
        result = await executeTool(toolName, args, targetAgent.id, ollamaUrl, depth + 1, targetAgent.workspace, hivePath, ws, maxRounds, signal, colonyContext);
      }

      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'sub_tool_result', subAgent: agentName, name: toolName, result }));
      }

      messages.push({ role: 'tool', content: JSON.stringify(result) });
    }
  }

  return '(agent reached max tool rounds without a final answer)';
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = {

  // ── Agent management ────────────────────────────────────────────────────────
  list_models: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'list_models',
        description: 'List all Ollama models that are currently installed and available to assign to agents. Call this before create_agent so you know which model names are valid.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler(_, { ollamaUrl }) {
      const res = await fetch(`${ollamaUrl}/api/tags`);
      if (!res.ok) return { error: `Ollama HTTP ${res.status}` };
      const data = await res.json();
      return (data.models || []).map(m => m.name);
    },
  },

  list_agents: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'list_agents',
        description: 'List all configured Hive agents.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler() {
      return listAgents().map(a => ({ id: a.id, name: a.name, description: a.description, model: a.model }));
    },
  },

  get_agent: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'get_agent',
        description: 'Get the full configuration of a specific agent by ID.',
        parameters: {
          type: 'object',
          properties: { agent_id: { type: 'string', description: 'The agent ID' } },
          required: ['agent_id'],
        },
      },
    },
    async handler({ agent_id }) {
      const agent = readAgent(agent_id);
      if (!agent) return { error: `Agent "${agent_id}" not found` };
      return agent;
    },
  },

  create_agent: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'create_agent',
        description: 'Create a new Hive agent. Omit model to use the same model as the caller. If you specify a model it must be already installed on Ollama — if it is not found the worker will fall back to the caller\'s model.',
        parameters: {
          type: 'object',
          properties: {
            name:          { type: 'string', description: 'Display name' },
            description:   { type: 'string', description: 'What this agent does' },
            model:         { type: 'string', description: 'Ollama model name. Omit to use the same model as the caller.' },
            system_prompt: { type: 'string', description: 'System prompt / personality' },
            temperature:   { type: 'number', description: 'Temperature 0-2' },
            tools:         { type: 'array', items: { type: 'string' }, description: 'Tool group IDs to enable' },
          },
          required: ['name'],
        },
      },
    },
    async handler({ name: agentName, ...rest }, { callerAgentId, ollamaUrl, colonyContext }) {
      if (!agentName) return { error: 'name is required' };
      // Resolve the worker's model:
      // 1. If no model specified, inherit the caller's model.
      // 2. If a model is specified, validate it exists on Ollama.
      //    If it doesn't exist, fall back to the caller's model and include a warning.
      //    This prevents hallucinated model names (e.g. "qwen3.5:latest") from causing
      //    silent 404 failures on every ask_agent call.
      const callerModel = callerAgentId ? readAgent(callerAgentId)?.model : null;
      if (!rest.model) {
        if (callerModel) rest.model = callerModel;
      } else {
        // Validate the specified model exists on Ollama
        const specifiedModel = stripProviderPrefix(rest.model);
        let modelValid = false;
        try {
          const tagsRes = await fetch(`${ollamaUrl}/api/tags`);
          if (tagsRes.ok) {
            const { models = [] } = await tagsRes.json();
            modelValid = models.some(m =>
              m.name === specifiedModel ||
              m.name === `${specifiedModel}:latest` ||
              m.name.startsWith(`${specifiedModel}:`),
            );
          }
        } catch {}
        if (!modelValid && callerModel) {
          rest._model_warning = `Model "${rest.model}" is not installed on Ollama. Falling back to "${callerModel}". Install it with: ollama pull ${specifiedModel}`;
          rest.model = callerModel;
        }
      }
      // Enforce per-colony worker cap. The orchestrator counts as one slot, so
      // "max workers" means max additional agents spawned beyond the orchestrator.
      if (colonyContext?.colonyId && typeof colonyContext.maxWorkers === 'number') {
        try {
          const row = db.prepare('SELECT agent_ids, orchestrator_id FROM colonies WHERE id=?').get(colonyContext.colonyId);
          if (row) {
            const ids = JSON.parse(row.agent_ids || '[]');
            const workerIds = ids.filter(id => id !== row.orchestrator_id);
            if (workerIds.length >= colonyContext.maxWorkers) {
              const workerList = workerIds.map(id => {
                const a = readAgent(id);
                return a ? `"${a.name}" (id: ${id})` : id;
              }).join(', ');
              return {
                error: `Worker cap reached (${colonyContext.maxWorkers}). You already have: ${workerList}. Use ask_agent with one of these IDs instead of creating a new worker.`,
              };
            }
          }
        } catch {}
      }
      // Sanitize worker tool lists:
      // • Strip colony_tools (set_plan, update_plan_step, mark_goal_achieved) — these
      //   are orchestrator-only. Workers given these accidentally will try to manage
      //   the plan themselves, which breaks everything.
      // • Strip agent_tools — workers should not be able to spawn sub-workers or call
      //   list_agents / get_agent inside a colony context.
      // • Auto-add memory so workers can persist findings across ask_agent calls.
      // • Do NOT auto-add sandbox — only workers explicitly given sandbox need it.
      //   Giving every worker a sandbox causes pure knowledge/research workers to
      //   reach for Python instead of using their trained knowledge.
      // • Auto-add web_search for workers whose name or system_prompt implies research.
      //   Models frequently forget to add web_search for Researcher workers, resulting
      //   in knowledge-only answers instead of real web lookups.
      if (colonyContext?.colonyId) {
        const rawWorkerTools = Array.isArray(rest.tools) ? [...rest.tools] : [];
        // Diagnostic: log when the model includes sandbox in a worker's raw tool list.
        if (rawWorkerTools.includes('sandbox')) {
          console.error(`[colony] worker "${agentName}" received sandbox in raw args — tools from model: ${JSON.stringify(rawWorkerTools)}`);
        }
        let tools = [...rawWorkerTools];
        tools = tools.filter(t => t !== 'colony_tools' && t !== 'agent_tools');
        if (!tools.includes('memory')) tools.push('memory');
        // Auto-inject web_search for research-typed workers so models don't have to
        // remember to add it explicitly — they often forget, causing memory-only answers.
        // Note: We inject web_search regardless of whether sandbox is present —
        // sandbox may be injected by the model or by accident, but researchers
        // should always have web_search available.
        const workerNameLower = (agentName || '').toLowerCase();
        const workerPromptLower = (rest.system_prompt || '').toLowerCase();
        const looksLikeResearcher = workerNameLower.includes('research') || workerNameLower.includes('analyst')
          || workerPromptLower.includes('search the web') || workerPromptLower.includes('web search')
          || workerPromptLower.includes('find information') || workerPromptLower.includes('research');
        if (looksLikeResearcher && !tools.includes('web_search')) {
          tools.push('web_search');
        }
        rest.tools = tools;
      }
      // Prevent duplicate names within a colony — name lookup would be ambiguous.
      if (colonyContext?.colonyId) {
        try {
          const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(colonyContext.colonyId);
          const ids = JSON.parse(row?.agent_ids || '[]');
          for (const existingId of ids) {
            const existingAgent = readAgent(existingId);
            if (existingAgent?.name === agentName) {
              return {
                error: `An agent named "${agentName}" already exists in this colony (id: ${existingId}). Use ask_agent with agent_id="${existingId}" to talk to it, or choose a different name.`,
                agent_id: existingId,
              };
            }
          }
        } catch {}
      }
      // Auto-inject colony context into worker system prompts so workers know
      // the overall mission and how to behave, even when the orchestrator writes
      // a bare one-liner prompt like "You are a Python expert."
      if (colonyContext?.colonyId) {
        try {
          const colRow = db.prepare('SELECT goal FROM colonies WHERE id=?').get(colonyContext.colonyId);
          if (colRow?.goal) {
            const tools = Array.isArray(rest.tools) ? rest.tools : [];
            const hasSandbox = tools.includes('sandbox');
            const hasWebSearch = tools.includes('web_search');
            const workerGuidance = [
              `\n\n---`,
              `[Colony Mission] ${colRow.goal}`,
              `[Worker Guidelines]`,
              `- Always produce a clear, detailed TEXT response — your response is your deliverable.`,
              `- Do NOT silently use tools and return nothing. Always summarize what you found or built.`,
              hasWebSearch
                ? `- You have web_search. Use it to find REAL information — do not answer from memory alone. Search first, then synthesize.`
                : hasSandbox
                  ? `- You have a sandbox: use write_file to save documents, run_python/run_bash to execute code.`
                  : `- You have no external tools. Use your trained knowledge directly and be explicit that findings are from training data, not live research.`,
              `- If a tool call succeeds, do NOT retry it.`,
              `- Answer directly and completely. Do not ask for clarification — make reasonable assumptions.`,
              `---`,
            ].join('\n');
            rest.system_prompt = (rest.system_prompt || 'Be helpful, direct, and concise.') + workerGuidance;
          }
        } catch {}
      }
      const modelWarning = rest._model_warning;
      delete rest._model_warning;
      const agent = writeAgent(null, { name: agentName, ...rest });
      if (colonyContext?.workersCreated) colonyContext.workersCreated.add(agent.id);
      return {
        success: true,
        agent_id: agent.id,
        agent,
        reminder: `IMPORTANT: Use agent_id="${agent.id}" (not the name) when calling ask_agent.`,
        ...(modelWarning ? { model_warning: modelWarning } : {}),
      };
    },
  },

  update_agent: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'update_agent',
        description: 'Update an existing agent. Only provide fields to change.',
        parameters: {
          type: 'object',
          properties: {
            agent_id:      { type: 'string' },
            name:          { type: 'string' },
            description:   { type: 'string' },
            model:         { type: 'string' },
            system_prompt: { type: 'string' },
            temperature:   { type: 'number' },
            tools:         { type: 'array', items: { type: 'string' } },
          },
          required: ['agent_id'],
        },
      },
    },
    async handler({ agent_id, ...updates }) {
      const existing = readAgent(agent_id);
      if (!existing) return { error: `Agent "${agent_id}" not found` };
      const agent = writeAgent(agent_id, { ...existing, ...updates });
      return { success: true, agent };
    },
  },

  delete_agent: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'delete_agent',
        description: 'Permanently delete an agent and all its files.',
        parameters: {
          type: 'object',
          properties: { agent_id: { type: 'string' } },
          required: ['agent_id'],
        },
      },
    },
    async handler({ agent_id }) {
      const existing = readAgent(agent_id);
      if (!existing) return { error: `Agent "${agent_id}" not found` };
      deleteAgent(agent_id);
      return { success: true, deleted_id: agent_id };
    },
  },

  ask_agent: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'ask_agent',
        description: 'Ask another agent a question. The target agent runs with its own system prompt, memory, and tools — so it can search the web, recall past context, etc. Use this to delegate to specialists.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'ID of the agent to consult' },
            message:  { type: 'string', description: 'Question or task to send' },
            context:  { type: 'string', description: 'Optional background context to share' },
          },
          required: ['agent_id', 'message'],
        },
      },
    },
    async handler({ agent_id, message, context }, { callerAgentId, ollamaUrl, depth, ws, hivePath, maxRounds, signal, colonyContext }) {
      if (agent_id === callerAgentId) return { error: 'An agent cannot ask itself' };
      if (depth >= 4) return { error: 'Maximum agent conversation depth reached' };

      let target = readAgent(agent_id);
      let resolvedId = agent_id;
      // The orchestrator sometimes passes the agent's display name instead of its ID.
      // If the direct lookup fails and we're in a colony, search colony members by name.
      if (!target && colonyContext?.colonyId) {
        try {
          const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(colonyContext.colonyId);
          const ids = JSON.parse(row?.agent_ids || '[]');
          for (const id of ids) {
            const candidate = readAgent(id);
            if (candidate?.name === agent_id) {
              target = candidate;
              resolvedId = id;
              break;
            }
          }
        } catch {}
      }
      if (!target) return { error: `Agent "${agent_id}" not found. Pass the agent_id returned by create_agent, not the agent name.` };
      if (!target.model) return { error: `Agent "${resolvedId}" has no model configured` };

      // In a colony run, maintain a persistent conversation thread per worker so
      // each ask_agent call continues where the last one left off. Without this,
      // every call starts a fresh conversation and the worker loses all prior context
      // (e.g. research findings from the previous step).
      const histories = colonyContext?.agentHistories;
      let userMessages;
      if (histories) {
        if (!histories.has(resolvedId)) {
          // First call to this agent: seed with optional context
          const seed = [];
          if (context) {
            seed.push({ role: 'user', content: `Context: ${context}` });
            seed.push({ role: 'assistant', content: 'Understood.' });
          }
          histories.set(resolvedId, seed);
        }
        const history = histories.get(resolvedId);
        history.push({ role: 'user', content: message });
        userMessages = history;
      } else {
        userMessages = [];
        if (context) {
          userMessages.push({ role: 'user', content: `Context: ${context}` });
          userMessages.push({ role: 'assistant', content: 'Understood.' });
        }
        userMessages.push({ role: 'user', content: message });
      }

      const response = await runAgentOnce(target, userMessages, ollamaUrl, depth, ws, hivePath, null, maxRounds, signal, colonyContext);

      // Append assistant reply to the thread so the next call has full context.
      if (histories) {
        histories.get(resolvedId).push({ role: 'assistant', content: response });
      }

      // Track which plan steps have been delegated to workers.
      // update_plan_step uses this to prevent marking steps done without real work.
      // We can't know which step the orchestrator is working on, so we mark the
      // current in_progress step as delegated when any ask_agent succeeds.
      if (colonyContext?.delegatedSteps && colonyContext?.colonyId) {
        try {
          const planRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
          if (planRow?.plan) {
            const plan = JSON.parse(planRow.plan);
            const inProgress = plan.steps.find(s => s.status === 'in_progress');
            if (inProgress) colonyContext.delegatedSteps.add(String(inProgress.id));
          }
        } catch {}
      }

      const noOutput = response === '(no response)' || response === '(agent reached max tool rounds without a final answer)';
      return {
        agent_name: target.name,
        agent_id: resolvedId,
        response,
        ...(noOutput ? { warning: 'Worker produced no output. Retry with a simpler, more explicit task description, or verify the worker has the correct tools. Do NOT mark the step done until you have real output.' } : {}),
      };
    },
  },

  // ── Shared blackboard ────────────────────────────────────────────────────────
  read_shared: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'read_shared',
        description: 'Read the shared blackboard — a common notepad all agents can see. Use this to check what other agents have written or to read shared context before starting a task.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler(_args, { hivePath }) {
      const content = readShared(hivePath);
      return { content: content || '(shared blackboard is empty)' };
    },
  },

  write_shared: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'write_shared',
        description: 'Write to the shared blackboard that all agents can read. Use this to leave findings, summaries, or coordination notes for other agents. Content REPLACES the current shared notes.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Full content to write to the shared blackboard (replaces existing)' },
          },
          required: ['content'],
        },
      },
    },
    async handler({ content }, { hivePath }) {
      writeShared(content, hivePath);
      return { success: true };
    },
  },

  // ── Colony tools (only meaningful inside a Colony run) ──────────────────────
  // These tools let the Orchestrator register a structured plan, update step
  // status, and explicitly signal goal completion. They gate on colonyContext
  // so they no-op with a clear error if invoked outside a Colony.

  set_plan: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'set_plan',
        description: 'Register the Colony plan as a structured checklist of concrete steps. Call this FIRST, before creating any worker agents. Replaces any existing plan. Each step should be a concrete, verifiable task. Keep descriptions short (one sentence).',
        parameters: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: 'Ordered list of plan steps',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Short unique id, e.g. "1", "2"' },
                  description: { type: 'string', description: 'One-sentence description of the step' },
                  assigned_to: { type: 'string', description: 'Optional: name of the worker agent responsible' },
                },
                required: ['id', 'description'],
              },
            },
          },
          required: ['steps'],
        },
      },
    },
    async handler({ steps }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'set_plan is only available inside a Colony run' };
      // Block re-planning once work has started — prevents the orchestrator from
      // wiping completed steps mid-run by calling set_plan a second time.
      const existingRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (existingRow?.plan) {
        const existing = JSON.parse(existingRow.plan);
        const hasStarted = (existing.steps || []).some(s => s.status !== 'pending');
        if (hasStarted) {
          return { error: 'Plan is already in progress and cannot be replaced. Use update_plan_step to update existing steps, or add_plan_step to append new ones.' };
        }
      }
      // Some models (llama3.1, mistral) stringify complex arguments instead of
      // sending a proper JSON array. Try to recover before rejecting.
      let stepsArr = steps;
      if (typeof stepsArr === 'string') {
        try {
          // Handle Python-style single-quoted strings too
          stepsArr = JSON.parse(stepsArr.replace(/'/g, '"'));
        } catch {
          return { error: 'steps must be an array of {id, description} objects' };
        }
      }
      if (!Array.isArray(stepsArr) || stepsArr.length === 0) return { error: 'steps must be a non-empty array' };
      const normalized = stepsArr
        .map((s, i) => ({
          id: String(s.id ?? i + 1),
          description: String(s.description || '').trim(),
          assigned_to: s.assigned_to ? String(s.assigned_to) : null,
          status: 'pending',
        }))
        .filter(s => s.description);
      if (normalized.length === 0) return { error: 'all steps had empty descriptions' };
      const plan = { steps: normalized, updated_at: Date.now() };
      db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
        .run(JSON.stringify(plan), colonyContext.colonyId);
      return { success: true, step_count: normalized.length, steps: normalized };
    },
  },

  add_plan_step: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'add_plan_step',
        description: 'Append a new step to the existing plan mid-run. Use this when you discover additional work that was not in the original plan. Do NOT use set_plan to add steps — it is locked once work has started.',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'One-sentence description of the new step' },
            assigned_to:  { type: 'string', description: 'Optional: worker name to assign this step to' },
          },
          required: ['description'],
        },
      },
    },
    async handler({ description, assigned_to }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'add_plan_step is only available inside a Colony run' };
      const trimmed = String(description || '').trim();
      if (!trimmed) return { error: 'description is required' };
      const row = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (!row?.plan) return { error: 'No plan has been set yet. Call set_plan first.' };
      const plan = JSON.parse(row.plan);
      // Generate a new ID that doesn't collide with existing ones.
      const existingIds = plan.steps.map(s => Number(s.id)).filter(n => !isNaN(n));
      const nextId = String(existingIds.length > 0 ? Math.max(...existingIds) + 1 : plan.steps.length + 1);
      const newStep = {
        id: nextId,
        description: trimmed,
        assigned_to: assigned_to ? String(assigned_to) : null,
        status: 'pending',
      };
      plan.steps.push(newStep);
      plan.updated_at = Date.now();
      db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
        .run(JSON.stringify(plan), colonyContext.colonyId);
      return { success: true, step: newStep, total_steps: plan.steps.length };
    },
  },

  update_plan_step: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'update_plan_step',
        description: 'Update one plan step as work progresses. Use this whenever a step changes state — in_progress when a worker starts it, done when verified working, blocked if something is preventing progress. Add a short note for context when blocked.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id of the step to update' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done', 'blocked'],
              description: 'New status for this step',
            },
            note: { type: 'string', description: 'Optional short note (max 500 chars)' },
          },
          required: ['id', 'status'],
        },
      },
    },
    async handler({ id, status, note }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'update_plan_step is only available inside a Colony run' };
      const validStatuses = ['pending', 'in_progress', 'done', 'blocked'];
      if (!validStatuses.includes(status)) return { error: `status must be one of: ${validStatuses.join(', ')}` };
      const row = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (!row?.plan) return { error: 'No plan has been set yet. Call set_plan first.' };
      const plan = JSON.parse(row.plan);
      const stepIndex = plan.steps.findIndex(s => String(s.id) === String(id));
      if (stepIndex === -1) return { error: `No plan step with id "${id}". Known ids: ${plan.steps.map(s => s.id).join(', ')}` };
      const step = plan.steps[stepIndex];
      // Idempotency nudge: if status unchanged, tell the model what to do next.
      if (step.status === status) {
        const nextPending = plan.steps.find(s => s.status === 'pending');
        const hint = status === 'in_progress'
          ? `Call ask_agent to have the worker complete this step, then mark it done.`
          : nextPending
            ? `Move on to step "${nextPending.id}": ${nextPending.description}`
            : `All steps are accounted for. Call mark_goal_achieved if everything is done.`;
        return { warning: `Step "${id}" is already ${status}. No change made. ${hint}`, step, plan };
      }
      // Prevent backtracking: can't reopen a completed step.
      if (step.status === 'done' && status === 'in_progress') {
        return { error: `Step "${id}" is already done and cannot be re-opened. Move on to the next pending step.` };
      }
      // Prevent skipping: can't mark a step in_progress if any earlier step is incomplete.
      if (status === 'in_progress') {
        const stuck = plan.steps.slice(0, stepIndex).find(s => s.status === 'in_progress');
        if (stuck) {
          return { error: `Step "${stuck.id}" is still in_progress. Mark it done (or blocked) before starting step "${id}".` };
        }
        const skipped = plan.steps.slice(0, stepIndex).find(s => s.status === 'pending');
        if (skipped) {
          return { error: `Step "${skipped.id}" hasn't been started yet. Work through steps in order — start step "${skipped.id}" before step "${id}".` };
        }
      }
      // Guard: can't jump from pending → done. Step must be in_progress first.
      if (status === 'done' && step.status === 'pending') {
        return {
          error: `Step "${id}" is still pending (never started). You must: (1) mark it in_progress, (2) call ask_agent to do the work, then (3) mark it done.`,
        };
      }
      // Guard: complete steps in order — can't mark done while earlier steps are unfinished.
      if (status === 'done') {
        const earlierUnfinished = plan.steps.slice(0, stepIndex).find(s => s.status !== 'done');
        if (earlierUnfinished) {
          return {
            error: `Step "${earlierUnfinished.id}" is not done yet (status: ${earlierUnfinished.status}). Complete earlier steps before finishing step "${id}".`,
          };
        }
      }
      // Guard: can't mark done without evidence of real work (ask_agent call).
      // Only applies once workers exist — if workersCreated is empty the orchestrator
      // has no workers yet and the check would be meaningless.
      if (status === 'done') {
        const delegated = colonyContext.delegatedSteps;
        const hasWorkers = colonyContext.workersCreated && colonyContext.workersCreated.size > 0;
        if (delegated && hasWorkers && !delegated.has(String(id))) {
          return {
            error: `Step "${id}" has not been delegated to a worker yet. Call ask_agent to have a worker do the actual work, then mark it done. Skipping delegation produces hollow, hallucinated results.`,
          };
        }
      }
      step.status = status;
      if (note) step.note = String(note).slice(0, 500);
      plan.updated_at = Date.now();
      db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
        .run(JSON.stringify(plan), colonyContext.colonyId);
      return { success: true, step, plan };
    },
  },

  mark_goal_achieved: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'mark_goal_achieved',
        description: 'Call this EXACTLY ONCE when the mission is fully and verifiably complete. This ends the Colony run successfully. Before calling, confirm every plan step is marked done and the final result actually works (files exist, services respond, tests pass).',
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Concise 2–4 sentence summary: what was built, where the key files are, and how to run/use it.',
            },
          },
          required: ['summary'],
        },
      },
    },
    async handler({ summary }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'mark_goal_achieved is only available inside a Colony run' };
      const trimmed = String(summary || '').trim();
      if (!trimmed) return { error: 'summary is required' };
      // Require that at least some plan exists and every step is done before declaring victory.
      const row = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (row?.plan) {
        const plan = JSON.parse(row.plan);
        const unfinished = (plan.steps || []).filter(s => s.status !== 'done');
        if (unfinished.length > 0) {
          return {
            error: `Cannot mark goal achieved: ${unfinished.length} plan step(s) are not yet done. Update them with update_plan_step first, or address the remaining work.`,
            unfinished: unfinished.map(s => ({ id: s.id, description: s.description, status: s.status })),
          };
        }
      }
      db.prepare('UPDATE colonies SET summary=?, updated_at=unixepoch() WHERE id=?').run(trimmed, colonyContext.colonyId);
      return { success: true, goal_achieved: true, summary: trimmed };
    },
  },

  // ── Pipeline management ──────────────────────────────────────────────────────
  list_pipelines: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'list_pipelines',
        description: 'List all pipelines. Returns id, name, description, and step count for each.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler() {
      const rows = db.prepare('SELECT id, name, description, steps FROM pipelines ORDER BY updated_at DESC').all();
      return rows.map(r => {
        const steps = JSON.parse(r.steps || '[]');
        return { id: r.id, name: r.name, description: r.description, step_count: steps.length };
      });
    },
  },

  create_pipeline: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'create_pipeline',
        description: 'Create a new pipeline. Each step has agent_id, label, and prompt. Use {prev} in the prompt for the previous step\'s output, {input} for the original user input.',
        parameters: {
          type: 'object',
          properties: {
            name:        { type: 'string', description: 'Pipeline name' },
            description: { type: 'string', description: 'What this pipeline does' },
            steps: {
              type: 'array',
              description: 'Pipeline steps in order',
              items: {
                type: 'object',
                properties: {
                  agent_id: { type: 'string', description: 'ID of the agent to run for this step' },
                  label:    { type: 'string', description: 'Display label for this step' },
                  prompt:   { type: 'string', description: 'Prompt template — use {prev} for previous output, {input} for original input' },
                  parallel: { type: 'boolean', description: 'If true, run concurrently with adjacent parallel steps' },
                },
                required: ['agent_id'],
              },
            },
          },
          required: ['name'],
        },
      },
    },
    async handler({ name, description = '', steps = [] }) {
      if (!name) return { error: 'name is required' };
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      db.prepare('INSERT INTO pipelines (id, name, description, steps) VALUES (?, ?, ?, ?)')
        .run(id, name, description, JSON.stringify(steps));
      return { success: true, pipeline_id: id, name, step_count: steps.length };
    },
  },

  run_pipeline: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'run_pipeline',
        description: 'Run a pipeline synchronously and return the final output once all steps complete.',
        parameters: {
          type: 'object',
          properties: {
            pipeline_id: { type: 'string', description: 'ID of the pipeline to run' },
            input:       { type: 'string', description: 'Initial input passed to the first step' },
          },
          required: ['pipeline_id', 'input'],
        },
      },
    },
    async handler({ pipeline_id, input }, { ollamaUrl, hivePath }) {
      const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(pipeline_id);
      if (!row) return { error: `Pipeline "${pipeline_id}" not found` };
      const steps = JSON.parse(row.steps || '[]');
      if (!steps.length) return { error: 'Pipeline has no steps' };
      if (!input?.trim()) return { error: 'input is required' };

      // Group consecutive parallel steps (mirrors pipelines route logic)
      const groups = [];
      let i = 0;
      while (i < steps.length) {
        if (steps[i].parallel) {
          const indices = [];
          while (i < steps.length && steps[i].parallel) { indices.push(i); i++; }
          groups.push({ parallel: true, indices });
        } else {
          groups.push({ parallel: false, indices: [i] });
          i++;
        }
      }

      let prevOutput = input.trim();
      for (const group of groups) {
        const groupPrev = prevOutput;

        // Validate all agents in the group first
        for (const idx of group.indices) {
          const step  = steps[idx];
          const agent = readAgent(step.agent_id);
          if (!agent)       return { error: `Step ${idx + 1}: agent "${step.agent_id}" not found` };
          if (!agent.model) return { error: `Step ${idx + 1}: agent "${step.agent_id}" has no model configured` };
        }

        if (!group.parallel) {
          const idx   = group.indices[0];
          const step  = steps[idx];
          const agent = readAgent(step.agent_id);
          const prompt = (step.prompt || '{prev}')
            .replace(/\{input\}/g, input.trim())
            .replace(/\{prev\}/g,  groupPrev);
          const toolsOverride = Array.isArray(step.tools) && step.tools.length > 0 ? step.tools : null;
          try {
            prevOutput = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, hivePath, toolsOverride);
          } catch (e) {
            return { error: `Step ${idx + 1} (${agent.name}) failed: ${e.message}` };
          }
        } else {
          const results = await Promise.all(
            group.indices.map(async (idx) => {
              const step  = steps[idx];
              const agent = readAgent(step.agent_id);
              const prompt = (step.prompt || '{prev}')
                .replace(/\{input\}/g, input.trim())
                .replace(/\{prev\}/g,  groupPrev);
              const toolsOverride = Array.isArray(step.tools) && step.tools.length > 0 ? step.tools : null;
              try {
                const output = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, hivePath, toolsOverride);
                return { idx, output, error: null };
              } catch (e) {
                return { idx, output: null, error: e.message };
              }
            }),
          );
          const failed = results.find(r => r.error);
          if (failed) return { error: `Step ${failed.idx + 1} failed: ${failed.error}` };
          prevOutput = results.map(r => r.output).join('\n\n---\n\n');
        }
      }
      return { success: true, final_output: prevOutput };
    },
  },

  // ── Schedule management ───────────────────────────────────────────────────────
  list_schedules: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'list_schedules',
        description: 'List all scheduled agent runs. Returns id, label, agent_id, cron_expr, enabled, last_run, and run_count for each.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler() {
      const rows = db.prepare(
        'SELECT id, agent_id, label, cron_expr, enabled, last_run, run_count FROM scheduled_runs ORDER BY created_at DESC',
      ).all();
      return rows;
    },
  },

  create_schedule: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'create_schedule',
        description: 'Create a scheduled run that fires an agent on a cron schedule. Uses standard 5-field cron syntax (e.g. "0 9 * * 1" = every Monday at 9am, "*/30 * * * *" = every 30 minutes).',
        parameters: {
          type: 'object',
          properties: {
            agent_id:  { type: 'string', description: 'ID of the agent to run' },
            label:     { type: 'string', description: 'Human-readable name for this schedule' },
            cron_expr: { type: 'string', description: 'Cron expression (5 fields: min hour day month weekday)' },
            prompt:    { type: 'string', description: 'Prompt to send to the agent on each run' },
            enabled:   { type: 'boolean', description: 'Enable immediately (default: true)' },
          },
          required: ['agent_id', 'label', 'cron_expr', 'prompt'],
        },
      },
    },
    async handler({ agent_id, label, cron_expr, prompt, enabled = true }) {
      const cron = require('node-cron');
      if (!cron.validate(cron_expr)) return { error: `Invalid cron expression: "${cron_expr}"` };

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      db.prepare('INSERT INTO scheduled_runs (id, agent_id, label, cron_expr, prompt, enabled, tools) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, agent_id, label, cron_expr, prompt, enabled ? 1 : 0, '[]');

      // Require scheduler lazily to avoid circular dependency (scheduler imports agentTools)
      const scheduler = require('./scheduler');
      const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id);
      scheduler.register(row);
      return { success: true, schedule_id: id, label, cron_expr, enabled };
    },
  },

  delete_schedule: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'delete_schedule',
        description: 'Delete a scheduled run permanently.',
        parameters: {
          type: 'object',
          properties: { schedule_id: { type: 'string', description: 'ID of the schedule to delete' } },
          required: ['schedule_id'],
        },
      },
    },
    async handler({ schedule_id }) {
      const existing = db.prepare('SELECT id FROM scheduled_runs WHERE id = ?').get(schedule_id);
      if (!existing) return { error: `Schedule "${schedule_id}" not found` };
      const scheduler = require('./scheduler');
      scheduler.unregister(schedule_id);
      db.prepare('DELETE FROM scheduled_runs WHERE id = ?').run(schedule_id);
      return { success: true, deleted_id: schedule_id };
    },
  },

  toggle_schedule: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'toggle_schedule',
        description: 'Enable or disable a scheduled run.',
        parameters: {
          type: 'object',
          properties: {
            schedule_id: { type: 'string', description: 'ID of the schedule' },
            enabled:     { type: 'boolean', description: 'true to enable, false to disable' },
          },
          required: ['schedule_id', 'enabled'],
        },
      },
    },
    async handler({ schedule_id, enabled }) {
      const existing = db.prepare('SELECT id FROM scheduled_runs WHERE id = ?').get(schedule_id);
      if (!existing) return { error: `Schedule "${schedule_id}" not found` };
      db.prepare('UPDATE scheduled_runs SET enabled=? WHERE id=?').run(enabled ? 1 : 0, schedule_id);
      const scheduler = require('./scheduler');
      const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(schedule_id);
      scheduler.register(row);
      return { success: true, schedule_id, enabled, label: row.label };
    },
  },

  // ── Sandbox ──────────────────────────────────────────────────────────────────
  shell: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'shell',
        description: 'Run a bash command inside your isolated sandbox container. Working directory is /workspace. Has Python 3, Node.js 20, npm, git, curl pre-installed. Output capped at 8000 chars.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Bash command to run' },
          },
          required: ['command'],
        },
      },
    },
    async handler({ command }, { callerAgentId }) {
      const sandbox = require('./sandbox');
      const { stdout, stderr, exitCode } = await sandbox.exec(callerAgentId, command);
      return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode };
    },
  },

  run_python: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'run_python',
        description: 'Execute Python 3 code in the sandbox. Available packages: requests, httpx, flask, fastapi, uvicorn, numpy, pandas, matplotlib, beautifulsoup4, sqlalchemy, pytest, black. Install others with install_package.',
        parameters: {
          type: 'object',
          properties: {
            code:     { type: 'string', description: 'Python source code' },
            filename: { type: 'string', description: 'Optional filename to save as (default: _run.py). Use this when the script imports other local files.' },
          },
          required: ['code'],
        },
      },
    },
    async handler({ code, filename = '_run.py' }, { callerAgentId }) {
      const sandbox = require('./sandbox');
      const safe    = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const tmpFile = `/tmp/${safe}`;
      // Write via base64 to avoid heredoc quoting issues
      const b64 = Buffer.from(code).toString('base64');
      await sandbox.exec(callerAgentId, `echo "${b64}" | base64 -d > ${tmpFile}`);
      const { stdout, stderr, exitCode } = await sandbox.exec(callerAgentId, `python3 ${tmpFile}`);
      return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode };
    },
  },

  install_package: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'install_package',
        description: 'Install a Python (pip) or Node.js (npm) package in the sandbox.',
        parameters: {
          type: 'object',
          properties: {
            package:  { type: 'string', description: 'Package name, e.g. "scikit-learn" or "express"' },
            manager:  { type: 'string', enum: ['pip', 'npm'], description: 'Package manager to use (default: pip)' },
          },
          required: ['package'],
        },
      },
    },
    async handler({ package: pkg, manager = 'pip' }, { callerAgentId }) {
      const sandbox = require('./sandbox');
      const cmd = manager === 'npm'
        ? `npm install -g ${pkg} 2>&1 | tail -5`
        : `pip install --quiet ${pkg} 2>&1 | tail -10`;
      const { stdout, stderr, exitCode } = await sandbox.exec(callerAgentId, cmd, 120_000);
      // Provide an unambiguous success/failure flag so the model doesn't mistake
      // pip's "WARNING: Running pip as root" for a failed install and retry endlessly.
      const success = exitCode === 0;
      const message = success
        ? `${pkg} installed successfully (exit 0). Do NOT call install_package again for this package.`
        : `Install failed (exit ${exitCode}).`;
      return { success, message, stdout: stdout.slice(0, 2000), exitCode };
    },
  },

  start_server: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'start_server',
        description: 'Start a web server in the sandbox background. Returns the external URL the user can open. Use ports 3000, 5000, 8000, or 8080 — these are pre-forwarded to your host.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to start the server, e.g. "python3 app.py" or "node server.js" or "uvicorn main:app --host 0.0.0.0 --port 8000"' },
            port:    { type: 'number', description: 'Port the server listens on inside the container (3000, 5000, 8000, or 8080)' },
            label:   { type: 'string', description: 'Short label for this server, e.g. "Flask app"' },
          },
          required: ['command', 'port'],
        },
      },
    },
    async handler({ command, port, label = 'server' }, { callerAgentId }) {
      const sandbox   = require('./sandbox');
      const logFile   = `/tmp/hive_server_${port}.log`;
      const pid       = await sandbox.execBackground(callerAgentId, command, logFile);
      // Give it a moment to start
      await new Promise(r => setTimeout(r, 1500));
      const hp = sandbox.hostPort(callerAgentId, port);
      const url = hp ? `http://localhost:${hp}` : null;
      // Tail the log for early errors
      const { stdout: log } = await sandbox.exec(callerAgentId, `tail -20 ${logFile} 2>/dev/null || echo ""`);
      return {
        success: !!pid,
        pid,
        label,
        container_port: port,
        host_url: url || `(port ${port} not forwarded — use 3000, 5000, 8000, or 8080)`,
        log: log.slice(0, 1000),
      };
    },
  },

  stop_server: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'stop_server',
        description: 'Stop a server running in the sandbox by port number.',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'Port the server is running on' },
          },
          required: ['port'],
        },
      },
    },
    async handler({ port }, { callerAgentId }) {
      const sandbox = require('./sandbox');
      const { stdout, exitCode } = await sandbox.exec(
        callerAgentId,
        `fuser -k ${port}/tcp 2>/dev/null && echo "stopped" || echo "nothing on port ${port}"`,
      );
      return { result: stdout.trim(), exitCode };
    },
  },

  list_processes: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'list_processes',
        description: 'List running processes in the sandbox.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler(_, { callerAgentId }) {
      const sandbox = require('./sandbox');
      const { stdout } = await sandbox.exec(callerAgentId, `ps aux --no-headers 2>/dev/null | grep -v 'ps aux\\|tail -f' | head -20`);
      return { processes: stdout.trim().split('\n').filter(Boolean) };
    },
  },

  write_file: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write or overwrite a file in the sandbox workspace. Path is relative to /workspace.',
        parameters: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'File path relative to /workspace, e.g. "app.py" or "src/index.js"' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
      },
    },
    async handler({ path: filePath, content }, { callerAgentId }) {
      const sandbox  = require('./sandbox');
      const dir      = sandbox.sandboxDir(callerAgentId);
      const resolved = path.resolve(path.join(dir, filePath));
      if (!resolved.startsWith(dir)) return { error: 'Path must be inside the sandbox workspace' };
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf8');
      return { success: true, path: filePath, bytes: content.length };
    },
  },

  read_file: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the sandbox workspace. Path is relative to /workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to /workspace' },
          },
          required: ['path'],
        },
      },
    },
    async handler({ path: filePath }, { callerAgentId }) {
      const sandbox  = require('./sandbox');
      const dir      = sandbox.sandboxDir(callerAgentId);
      const resolved = path.resolve(path.join(dir, filePath));
      if (!resolved.startsWith(dir)) return { error: 'Path must be inside the sandbox workspace' };
      if (!fs.existsSync(resolved))  return { error: `File not found: ${filePath}` };
      const content = fs.readFileSync(resolved, 'utf8');
      return { content: content.slice(0, 16000), truncated: content.length > 16000 };
    },
  },

  delete_file: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Delete a file or directory in the sandbox workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File or directory path relative to /workspace' },
          },
          required: ['path'],
        },
      },
    },
    async handler({ path: filePath }, { callerAgentId }) {
      const sandbox  = require('./sandbox');
      const dir      = sandbox.sandboxDir(callerAgentId);
      const resolved = path.resolve(path.join(dir, filePath));
      if (!resolved.startsWith(dir)) return { error: 'Path must be inside the sandbox workspace' };
      if (!fs.existsSync(resolved))  return { error: `Not found: ${filePath}` };
      fs.rmSync(resolved, { recursive: true, force: true });
      return { success: true, deleted: filePath };
    },
  },

  move_file: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'move_file',
        description: 'Move or rename a file in the sandbox workspace.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source path relative to /workspace' },
            to:   { type: 'string', description: 'Destination path relative to /workspace' },
          },
          required: ['from', 'to'],
        },
      },
    },
    async handler({ from, to }, { callerAgentId }) {
      const sandbox   = require('./sandbox');
      const dir       = sandbox.sandboxDir(callerAgentId);
      const srcRes    = path.resolve(path.join(dir, from));
      const dstRes    = path.resolve(path.join(dir, to));
      if (!srcRes.startsWith(dir) || !dstRes.startsWith(dir)) return { error: 'Paths must be inside the sandbox workspace' };
      if (!fs.existsSync(srcRes)) return { error: `Not found: ${from}` };
      fs.mkdirSync(path.dirname(dstRes), { recursive: true });
      fs.renameSync(srcRes, dstRes);
      return { success: true, from, to };
    },
  },

  list_files: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in the sandbox workspace.',
        parameters: {
          type: 'object',
          properties: {
            directory: { type: 'string', description: 'Subdirectory to list (default: workspace root)' },
          },
          required: [],
        },
      },
    },
    async handler({ directory = '.' }, { callerAgentId }) {
      const sandbox = require('./sandbox');
      const { stdout } = await sandbox.exec(
        callerAgentId,
        `find ${directory} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.*' | sort | head -100`,
      );
      return { files: stdout.trim().split('\n').filter(Boolean) };
    },
  },

  // ── Memory ───────────────────────────────────────────────────────────────────
  save_memory: {
    group: 'memory',
    definition: {
      type: 'function',
      function: {
        name: 'save_memory',
        description: 'Persist information to your long-term memory. Call this whenever the user shares something worth remembering across sessions. The content REPLACES the current memory — include everything you want to keep.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Full memory content (markdown). Replaces existing memory.' },
          },
          required: ['content'],
        },
      },
    },
    async handler({ content }, { workspace }) {
      if (!workspace) return { error: 'No workspace available for this agent' };
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'MEMORY.md'), content.trimEnd() + '\n', 'utf8');
      return { success: true, message: 'Memory saved.' };
    },
  },

  // ── Web search ───────────────────────────────────────────────────────────────
  web_search: {
    group: 'web_search',
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for current information. Use for news, facts, recent events, or anything that may have changed since your training cutoff.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query'],
        },
      },
    },
    async handler({ query }, { ollamaUrl }) {
      const res = await fetch(`${ollamaUrl}/api/experimental/web_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), max_results: 5 }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `Web search failed (${res.status}): ${body}` };
      }
      const data = await res.json();
      if (!data.results?.length) return { results: [], message: 'No results found.' };
      return {
        results: data.results.map(r => ({
          title:   r.title,
          url:     r.url,
          snippet: r.content?.slice(0, 400) || '',
        })),
      };
    },
  },

  web_fetch: {
    group: 'web_search',
    definition: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch and read the full content of a specific web page by URL.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The URL to fetch' } },
          required: ['url'],
        },
      },
    },
    async handler({ url }, { ollamaUrl }) {
      const res = await fetch(`${ollamaUrl}/api/experimental/web_fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `Web fetch failed (${res.status}): ${body}` };
      }
      const data = await res.json();
      return { title: data.title || '', content: data.content || '(no content)', url };
    },
  },
};

// ── Build tool list for a given agent ─────────────────────────────────────────
// enabledGroups: array like ['web_search', 'memory', 'mcp:abc123']
// Built-in tools are matched by group; mcp: entries are resolved via mcpManager.
function getToolDefinitions(enabledGroups = []) {
  if (!enabledGroups.length) return [];

  const builtIn = Object.values(TOOLS)
    .filter(t => enabledGroups.includes(t.group))
    .map(t => t.definition);

  const mcpServerIds = enabledGroups
    .filter(g => g.startsWith('mcp:'))
    .map(g => g.slice(4));
  const mcpDefs = mcpManager.getToolDefinitions(mcpServerIds);

  return [...builtIn, ...mcpDefs];
}

// ── Execute a tool call ───────────────────────────────────────────────────────
async function executeTool(name, args, callerAgentId, ollamaUrl, depth = 0, workspace = null, hivePath = null, ws = null, maxRounds = MAX_SUB_ROUNDS, signal = null, colonyContext = null) {
  // Route MCP tools first
  if (mcpManager.isMcpTool(name)) {
    try {
      const result = await mcpManager.callTool(name, args);
      return { result };
    } catch (err) {
      return { error: err.message };
    }
  }

  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    return await tool.handler(args, { callerAgentId, ollamaUrl, depth, workspace, hivePath, ws, maxRounds, signal, colonyContext });
  } catch (err) {
    if (err.name === 'AbortError' || err.message === 'Colony run was stopped') throw err;
    return { error: err.message };
  }
}

module.exports = { getToolDefinitions, executeTool, runAgentOnce, readMemory, readShared };
