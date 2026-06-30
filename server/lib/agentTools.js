const fs   = require('fs');
const path = require('path');
const { listAgents, readAgent, writeAgent, deleteAgent } = require('./agentParser');
const mcpManager = require('./mcpClient');
const db = require('../db');
const providers = require('./providers');
const protocol = require('./colonyProtocol');
const { updateGitHubIssue, detectGitHubRepo } = require('./githubBoard');
const { normalizeOllamaUrl } = require('./ollamaUrl');
const { logSwallowed } = require('./logSwallowed');

const MODEL_ROUND_TIMEOUT_MS = 180_000;

// Resolve the canonical role key for the calling agent inside a colony run.
// Recipe operators seed a roleByAgentId map in colonyContext; fall back to an
// explicit arg, then the agent's persona_role/name so the blackboard still gets
// a readable author label.
function resolveRoleKey(colonyContext, callerAgentId, explicit) {
  if (explicit) return explicit;
  const map = colonyContext?.roleByAgentId;
  if (map && callerAgentId && typeof map.get === 'function') {
    const key = map.get(callerAgentId);
    if (key) return key;
  }
  return null;
}

// Classify a tool result as a permission/authorization failure. Used by the
// circuit-breaker so agents stop hammering a tool that needs a credential or
// scope, and the user gets one actionable message instead of a retry loop.
const PERMISSION_ERROR_RE = /\b(permission denied|not authoriz|unauthoriz|forbidden|access denied|EACCES|insufficient (?:scope|permission|access)|requires? (?:the )?[\w .-]*(?:scope|permission|token|credential)|missing (?:scope|permission|token|credential|api key)|no (?:api key|token|credential)|authentication (?:failed|required)|401|403)\b/i;

// Agents see the workspace as "/workspace" inside the sandbox and routinely
// prefix relative paths with it ("workspace/frontend/...", "/workspace/app.py"),
// which used to create a literal nested workspace/ directory in the repo.
// Strip the prefix so paths always resolve from the repo/workspace root.
function stripWorkspacePrefix(p) {
  return String(p || '').replace(/^\/?(?:workspace\/)+/, '');
}

function isPermissionError(result) {
  if (!result || typeof result !== 'object') return false;
  const msg = typeof result.error === 'string' ? result.error : '';
  return PERMISSION_ERROR_RE.test(msg);
}

function permissionGuidance(toolName, errMsg) {
  return `ACTION REQUIRED — "${toolName}" failed with a permissions/auth error: ${errMsg}. ` +
    `This means a credential, API key, or scope is missing — it will NOT succeed on retry. ` +
    `Stop attempting this action. Report to the user exactly what needs to be enabled (e.g. set the ` +
    `relevant API key/token in Settings → Integrations, or grant the MCP server the required scope), ` +
    `then continue with any work that does not depend on it.`;
}

function agentLabel(colonyContext, callerAgentId, explicitRole) {
  const roleKey = resolveRoleKey(colonyContext, callerAgentId, explicitRole);
  const meta = roleKey ? protocol.DEV_TEAM_ROLES[roleKey] : null;
  if (meta) return meta.name;
  const a = callerAgentId ? readAgent(callerAgentId) : null;
  return a?.persona_role || a?.name || roleKey || 'agent';
}

const PROJECT_CONTEXT_FILES = ['PRD.md', 'docs/PRD.md', 'docs/prd.md', 'README.md', 'readme.md', 'SPEC.md', 'docs/SPEC.md'];
const PROJECT_CONTEXT_MAX_CHARS = 9000;

function readProjectContextFiles(repoPath) {
  if (!repoPath) return [];
  const files = [];
  for (const rel of PROJECT_CONTEXT_FILES) {
    try {
      const p = path.join(repoPath, rel);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      const content = fs.readFileSync(p, 'utf8');
      files.push({
        path: rel,
        content: content.slice(0, PROJECT_CONTEXT_MAX_CHARS),
        truncated: content.length > PROJECT_CONTEXT_MAX_CHARS,
      });
    } catch (e) { logSwallowed('agentTools:readProjectContext', e, { file: rel }); }
  }
  return files;
}

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

async function validateAgentModel(model, ollamaUrl) {
  const parsed = providers.parseModel(model);
  if (!parsed.modelId) return { ok: false, error: 'model is empty' };
  const normalizedOllamaUrl = normalizeOllamaUrl(ollamaUrl);

  if (parsed.provider !== 'ollama') {
    if (!providers.hasKey(parsed.provider)) {
      const label = providers.LABEL?.[parsed.provider] || parsed.provider;
      return { ok: false, error: `${label} API key is not set. Add it in Settings → Model Providers or set the provider environment variable.` };
    }
    return { ok: true, provider: parsed.provider, modelId: parsed.modelId };
  }

  try {
    const tagsRes = await fetch(`${normalizedOllamaUrl}/api/tags`);
    if (tagsRes.ok) {
      const { models = [] } = await tagsRes.json();
      const modelValid = models.some(m =>
        m.name === parsed.modelId ||
        m.name === `${parsed.modelId}:latest` ||
        m.name.startsWith(`${parsed.modelId}:`),
      );
      if (modelValid) return { ok: true, provider: 'ollama', modelId: parsed.modelId };
    }
  } catch (e) { logSwallowed('agentTools:validateModel', e); }

  return {
    ok: false,
    provider: 'ollama',
    modelId: parsed.modelId,
    error: `Model "${model}" is not installed on Ollama. Install it with: ollama pull ${parsed.modelId}`,
  };
}

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
  // Permission circuit-breaker: tools that have already returned a permission/
  // auth error this turn. On the first hit we tell the agent what to do; a second
  // hit on the same tool short-circuits so it can't loop on an unfixable error.
  const permissionTools = (colonyContext && colonyContext.permissionTools) || new Set();
  if (colonyContext && !colonyContext.permissionTools) colonyContext.permissionTools = permissionTools;

  // Per-agent budget: mint (once) a gateway virtual key carrying this agent's
  // max_budget so the gateway enforces the cap. Falls back to the shared key.
  let agentGatewayKey = targetAgent.gateway_key || null;
  if (!agentGatewayKey && Number(targetAgent.gateway_budget_usd) > 0) {
    try { agentGatewayKey = await providers.ensureAgentGatewayKey(targetAgent); } catch (e) { logSwallowed('agentTools:ensureGatewayKey', e, { agentId: targetAgent.id }); }
  }

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error('Colony run was stopped');

    // Stream one model round through the provider layer (Ollama or a cloud
    // provider, routed by the model id prefix). The provider yields normalized
    // events; we accumulate them into the same { content, thinking, tool_calls }
    // shape the tool loop below already expects.
    const acc = { content: '', thinking: '', tool_calls: null };

    const roundAc = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { roundAc.abort(); } catch {} /* abort is best-effort */
    }, MODEL_ROUND_TIMEOUT_MS);
    const onAbort = () => { try { roundAc.abort(); } catch {} /* abort is best-effort */ };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      for await (const ev of providers.streamChat(targetAgent.model, {
        messages,
        tools: targetTools,
        options: {
          ...(colonyContext?.reasoningByAgentId?.has?.(targetAgent.id)
            ? { reasoning: colonyContext.reasoningByAgentId.get(targetAgent.id) }
            : {}),
          // Spend attribution (gateway logs this per request).
          metadata: {
            agent_id: targetAgent.id,
            agent_name: agentName,
            ...(colonyContext?.colonyId ? { colony_id: colonyContext.colonyId } : {}),
            ...(colonyContext?.roleByAgentId?.get?.(targetAgent.id)
              ? { role: colonyContext.roleByAgentId.get(targetAgent.id) }
              : {}),
            source: colonyContext ? 'colony' : (depth > 0 ? 'sub_agent' : 'agent'),
          },
          // Per-agent virtual key (budget enforcement) when minted; else shared key.
          gatewayKey: agentGatewayKey || undefined,
        },
        signal: roundAc.signal,
      })) {
        if (ev.type === 'content') {
          acc.content += ev.delta;
          if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'token', subAgent: agentName, delta: ev.delta, kind: 'content' }));
          }
        } else if (ev.type === 'thinking') {
          acc.thinking += ev.delta;
          if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'token', subAgent: agentName, delta: ev.delta, kind: 'thinking' }));
          }
        } else if (ev.type === 'tool_call') {
          (acc.tool_calls ||= []).push(ev.call);
        }
      }
    } catch (streamErr) {
      if (timedOut) throw new Error(`Model request timed out for "${targetAgent.model}" after ${Math.round(MODEL_ROUND_TIMEOUT_MS / 1000)}s`);
      if (streamErr.name === 'AbortError' || streamErr.message === 'Colony run was stopped' || signal?.aborted) throw streamErr;
      throw new Error(`Model request failed for "${targetAgent.model}": ${streamErr.message}`);
    } finally {
      clearTimeout(timeout);
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch {} /* listener may already be removed */
      }
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

    if (acc.thinking && ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'thinking', subAgent: agentName, content: acc.thinking }));
    }

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
      } else if (permissionTools.has(toolName)) {
        // Already failed on permissions once — do not run it again.
        result = { error: `HALTED: "${toolName}" already failed with a permissions/auth error and was not retried. The required access is still not enabled. Report what the user needs to enable and proceed without this tool.`, permission_required: true, halted: true };
      } else {
        result = await executeTool(toolName, args, targetAgent.id, ollamaUrl, depth + 1, targetAgent.workspace, hivePath, ws, maxRounds, signal, colonyContext);
        if (isPermissionError(result)) {
          permissionTools.add(toolName);
          const original = result.error;
          result = { error: permissionGuidance(toolName, original), permission_required: true, tool: toolName, original_error: original };
          if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'permission_required', subAgent: agentName, name: toolName, message: original }));
          }
        }
      }

      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'sub_tool_result', subAgent: agentName, name: toolName, result }));
      }

      messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id, name: toolName });
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
        description: 'List models available to assign to agents, across all configured providers (Ollama plus any cloud provider with an API key set). Cloud model ids are prefixed (e.g. "anthropic/claude-...", "openai/gpt-...", "gemini/..."); Ollama models use their bare name. Call this before create_agent so you know which model ids are valid.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler() {
      const { listAllModels } = require('./providers/listModels');
      const grouped = await listAllModels();
      // Flatten to a list of valid model ids the model field accepts.
      return Object.values(grouped).flat().map(m => m.id);
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
        description: 'Create a new Hive agent. Omit model to use the same model as the caller. Models can be bare Ollama ids or cloud-prefixed ids such as "anthropic/claude-...", "openai/gpt-...", or "gemini/...". Call list_models first when possible.',
        parameters: {
          type: 'object',
          properties: {
            name:          { type: 'string', description: 'Display name' },
            description:   { type: 'string', description: 'What this agent does' },
            model:         { type: 'string', description: 'Model id. Use bare Ollama names for local models, or provider-prefixed cloud ids like anthropic/claude-sonnet-4-6. Omit to use the same model as the caller.' },
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
      // 2. If a model is specified, validate it for its provider. Ollama must be
      //    installed locally; cloud providers must have a key configured. Unknown
      //    cloud model names are allowed as custom ids once the provider is usable.
      const callerModel = callerAgentId ? readAgent(callerAgentId)?.model : null;
      if (!rest.model) {
        if (callerModel) rest.model = callerModel;
      } else {
        const validation = await validateAgentModel(rest.model, ollamaUrl);
        if (!validation.ok && callerModel) {
          rest._model_warning = `${validation.error}. Falling back to "${callerModel}".`;
          rest.model = callerModel;
        } else if (!validation.ok) {
          return { error: validation.error };
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
        } catch (e) { logSwallowed('agentTools:workerCap', e, { colonyId: colonyContext.colonyId }); }
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
        // Every colony worker joins the shared Blackboard / protocol surface.
        if (!tools.includes('protocol')) tools.push('protocol');
        rest.tools = tools;
        // Colony-owned worker — keep it out of the main Agents list.
        rest.ephemeral = true;
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
        } catch (e) { logSwallowed('agentTools:duplicateNameCheck', e, { colonyId: colonyContext.colonyId }); }
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
        } catch (e) { logSwallowed('agentTools:workerGuidance', e, { colonyId: colonyContext.colonyId }); }
      }
      const modelWarning = rest._model_warning;
      delete rest._model_warning;
      const agent = writeAgent(null, { name: agentName, ...rest });
      if (colonyContext?.workersCreated) colonyContext.workersCreated.add(agent.id);
      if (colonyContext?.reasoningByAgentId) {
        colonyContext.reasoningByAgentId.set(agent.id, !!colonyContext.workerReasoningDefault);
      }
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
    groups: ['agent_tools', 'delegation'],
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
        } catch (e) { logSwallowed('agentTools:resolveAgentByName', e, { colonyId: colonyContext.colonyId }); }
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
        if (colonyContext?.colonyId) {
          try { protocol.persistAgentHistory(colonyContext.colonyId, resolvedId, histories.get(resolvedId)); } catch (e) { logSwallowed('agentTools:persistHistory', e, { agentId: resolvedId }); }
        }
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
        } catch (e) { logSwallowed('agentTools:markDelegated', e, { colonyId: colonyContext.colonyId }); }
      }

      const noOutput = response === '(no response)' || response === '(agent reached max tool rounds without a final answer)';

      // Protocol fallback: weak models routinely END WITH TEXT ("BA handoff: …")
      // instead of calling the handoff tool, which leaves the ledger empty, blocks
      // downstream preconditions, and freezes plan auto-advance. If this worker's
      // role has exactly one outgoing flow edge whose preconditions are satisfied
      // and no handoff on record, record it from the response on the worker's behalf.
      let autoHandoff = null;
      let flowHint = null;
      if (!noOutput && colonyContext?.colonyId && protocol.hasProtocol(colonyContext.recipeId)) {
        try {
          const roleKey = colonyContext.roleByAgentId?.get?.(resolvedId);
          const flow = protocol.getFlow(colonyContext.recipeId) || [];
          // Flow-order nudge: if the operator delegated to a role that is NOT the
          // next expected one, say so explicitly. Without this the operator can
          // delegate in plan order (dev first), no edge ever becomes eligible,
          // and the run ends with zero handoffs on the ledger.
          {
            const ledgerNow = protocol.listHandoffs(colonyContext.colonyId);
            const satisfiedEdge = (e) => ledgerNow.some(h =>
              h.from_agent === e.from && h.to_agent === e.to &&
              h.protocol_status === 'ok' && h.status !== 'rejected');
            const nextEdge = flow.find(e => !satisfiedEdge(e));
            if (nextEdge && roleKey && roleKey !== nextEdge.from) {
              flowHint = `Out of flow order: the next expected handoff is ${nextEdge.from}→${nextEdge.to} (${nextEdge.payload}), so you should be delegating to ${nextEdge.from} now. Work done out of order cannot be handed off and will not count toward completion.`;
            }
          }
          const outgoing = flow.filter(e => e.from === roleKey);
          if (roleKey && outgoing.length === 1) {
            const edge = outgoing[0];
            const ledger = protocol.listHandoffs(colonyContext.colonyId);
            const alreadyRecorded = ledger.some(h =>
              h.from_agent === edge.from && h.to_agent === edge.to &&
              h.protocol_status === 'ok' && h.status !== 'rejected');
            const check = protocol.checkPreconditions(colonyContext.colonyId, colonyContext.recipeId, edge.from, edge.to);
            if (!alreadyRecorded && check.ok) {
              const summary = String(response).slice(0, 600);
              const record = protocol.recordHandoff(colonyContext.colonyId, {
                fromRole: edge.from, toRole: edge.to,
                payload: {
                  target_agent: edge.to, from: edge.from, contract: edge.payload,
                  summary, auto_recorded: true,
                },
                protocolStatus: 'ok', status: 'accepted',
                historyRef: protocol.historyRefForAgent(resolvedId),
              });
              protocol.writeBlackboard(colonyContext.colonyId, target.name, 'message',
                `Handoff → ${edge.to} (${edge.payload}) [auto-recorded from worker response]: ${summary.slice(0, 200)}`,
                { handoff_id: record.id, auto_recorded: true });
              // Auto-advance the plan exactly like an explicit handoff tool call.
              let updatedPlan = null;
              const planRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
              if (planRow?.plan) {
                const plan = JSON.parse(planRow.plan);
                const step = (plan.steps || []).find(s => s.status === 'in_progress')
                  || (plan.steps || []).find(s => s.status === 'pending');
                if (step) {
                  step.status = 'done';
                  step.note = `auto-completed: handoff ${edge.from}→${edge.to} accepted`;
                  plan.updated_at = Date.now();
                  db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
                    .run(JSON.stringify(plan), colonyContext.colonyId);
                  if (colonyContext.delegatedSteps) colonyContext.delegatedSteps.add(String(step.id));
                  updatedPlan = plan;
                }
              }
              autoHandoff = {
                handoff_id: record.id, from: edge.from, to: edge.to,
                contract: edge.payload, status: 'accepted',
                ...(updatedPlan ? { plan: updatedPlan } : {}),
              };
            }
          }
        } catch (e) { logSwallowed('agentTools:autoHandoff', e, { colonyId: colonyContext.colonyId }); }
      }

      return {
        agent_name: target.name,
        agent_id: resolvedId,
        response,
        ...(autoHandoff ? { auto_handoff: autoHandoff, note: `The worker did not call the handoff tool, so its ${autoHandoff.from}→${autoHandoff.to} handoff was auto-recorded from its response. The flow has advanced — delegate to the next role.` } : {}),
        ...(flowHint && !autoHandoff ? { flow_hint: flowHint } : {}),
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

  get_webhook_event: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'get_webhook_event',
        description: 'Fetch the FULL raw payload of a webhook event by its id. The initial ' +
          'context you were given is a distilled subset of the event; call this only when you ' +
          'need fields that were not included in that context. Pass the _event_id from your input.',
        parameters: {
          type: 'object',
          properties: {
            event_id: { type: 'string', description: 'The _event_id from the provided context envelope' },
            include_headers: { type: 'boolean', description: 'Also return the request headers (default false)' },
          },
          required: ['event_id'],
        },
      },
    },
    async handler({ event_id, include_headers = false }) {
      if (!event_id) return { error: 'event_id is required' };
      const row = db.prepare('SELECT payload, headers, event_type FROM webhook_events WHERE id = ?').get(event_id);
      if (!row) return { error: `No webhook event with id ${event_id}` };
      const out = { event_type: row.event_type };
      try { out.payload = JSON.parse(row.payload); } catch { out.payload = row.payload; }
      if (include_headers) {
        try { out.headers = JSON.parse(row.headers); } catch { out.headers = row.headers; }
      }
      return out;
    },
  },

  // ── Colony Communication Protocol tools (group: 'protocol') ─────────────────
  // The structured layer that lets seeded colony agents collaborate: a shared
  // blackboard, checkpointing, tool-based handoffs with command objects, ACP
  // messaging, and the "not-understood" act. All gate on colonyContext.colonyId.

  project_context: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'project_context',
        description: 'Read the colony work-item source context: linked GitHub issue/project card, repo path, and local PRD/README/SPEC excerpts. Call this before role work so requirements are grounded in the repo and board item, not just the operator summary.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler(_, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'project_context is only available inside a Colony run' };
      const row = db.prepare('SELECT goal, repo_path, board_card FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (!row) return { error: `Colony "${colonyContext.colonyId}" not found` };
      let board_card = null;
      try { board_card = row.board_card ? JSON.parse(row.board_card) : null; } catch (e) { logSwallowed('agentTools:parseBoardCard', e, { colonyId: colonyContext.colonyId }); }
      return {
        repo_path: row.repo_path || null,
        board_card,
        goal: row.goal,
        source_files: readProjectContextFiles(row.repo_path),
        guidance: 'Use this source context in your handoff payload. Cite the GitHub issue/project card and any PRD/README/SPEC file you relied on. If no files are returned, say that explicitly.',
      };
    },
  },

  blackboard_read: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'blackboard_read',
        description: 'Read the colony Shared Context Layer (the "Blackboard") — an append-only log of state, blockers, checkpoints, and progress from every agent. ALWAYS read this before starting work so you pick up where others left off. Optionally filter by entry_type or agent.',
        parameters: {
          type: 'object',
          properties: {
            entry_type: { type: 'string', enum: ['state', 'blocker', 'checkpoint', 'progress', 'assistance', 'message'], description: 'Only return entries of this type.' },
            agent: { type: 'string', description: 'Only return entries written by this agent label.' },
            limit: { type: 'number', description: 'Max entries (default 100).' },
          },
          required: [],
        },
      },
    },
    async handler({ entry_type, agent, limit }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'blackboard_read is only available inside a Colony run' };
      let entries = protocol.readBlackboard(colonyContext.colonyId, { entryType: entry_type, agent, limit });
      // Workers habitually filter by their OWN role and see nothing, then redo
      // upstream work from scratch. If a filter matched nothing but the board
      // has entries, return the unfiltered board with a note instead of an
      // empty result.
      if (entries.length === 0 && (agent || entry_type)) {
        const all = protocol.readBlackboard(colonyContext.colonyId, { limit });
        if (all.length > 0) {
          return {
            count: all.length,
            entries: all,
            note: `No entries matched your filter (${agent ? `agent="${agent}"` : ''}${agent && entry_type ? ', ' : ''}${entry_type ? `entry_type="${entry_type}"` : ''}) — showing ALL ${all.length} blackboard entries so you have the full shared context.`,
          };
        }
      }
      return { count: entries.length, entries };
    },
  },

  blackboard_write: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'blackboard_write',
        description: 'Append an entry to the colony Blackboard so other agents can see your state. APPENDS — it never overwrites prior notes. Use entry_type "blocker" to flag something that stops progress, "state" for completed work or shared facts.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What to record for the rest of the team.' },
            entry_type: { type: 'string', enum: ['state', 'blocker', 'progress'], description: 'Kind of entry (default state).' },
          },
          required: ['content'],
        },
      },
    },
    async handler({ content, entry_type = 'state' }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'blackboard_write is only available inside a Colony run' };
      if (!content || !String(content).trim()) return { error: 'content is required' };
      const author = agentLabel(colonyContext, callerAgentId);
      const entry = protocol.writeBlackboard(colonyContext.colonyId, author, entry_type, content);
      return { success: true, entry_id: entry.id, agent: author, entry_type: entry.entry_type };
    },
  },

  checkpoint: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'checkpoint',
        description: 'Persist a progress checkpoint to the Blackboard so that if you fail or are interrupted, another agent can resume from a fresh context. Record what is done and what remains.',
        parameters: {
          type: 'object',
          properties: {
            progress: { type: 'string', description: 'Summary of work completed so far.' },
            next_step: { type: 'string', description: 'The next action a fresh agent should take.' },
          },
          required: ['progress'],
        },
      },
    },
    async handler({ progress, next_step }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'checkpoint is only available inside a Colony run' };
      const author = agentLabel(colonyContext, callerAgentId);
      const content = next_step ? `${progress}\n\nNEXT: ${next_step}` : String(progress || '');
      const entry = protocol.writeBlackboard(colonyContext.colonyId, author, 'checkpoint', content, { next_step: next_step || null });
      return { success: true, checkpoint_id: entry.id, agent: author };
    },
  },

  handoff: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'handoff',
        description: 'Hand off control to the next specialist using a structured command object. Verifies the handoff is allowed by the role-specific flow and that all preconditions are met BEFORE proceeding. If the target or ordering is invalid it returns a protocol violation instead of proceeding. Accepted handoffs auto-advance the colony plan.',
        parameters: {
          type: 'object',
          properties: {
            to_role: { type: 'string', description: 'Role key of the target agent, e.g. "project_manager", "software_developer", "qa_engineer".' },
            summary: { type: 'string', description: 'Concise summary of the work you completed.' },
            payload: { type: 'object', description: 'The contract payload for this edge (e.g. validated business rules, component specs, PR link). Match your output_schema.' },
            artifacts: { type: 'array', items: { type: 'string' }, description: 'Optional file paths, PR links, or URLs.' },
            from_role: { type: 'string', description: 'Your own role key. Usually inferred automatically; only set if asked.' },
          },
          required: ['to_role', 'summary'],
        },
      },
    },
    async handler({ to_role, summary, payload = {}, artifacts = [], from_role }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'handoff is only available inside a Colony run' };
      const recipeId = colonyContext.recipeId;
      if (!protocol.hasProtocol(recipeId)) {
        return { error: `No communication protocol flow is defined for this colony (recipe "${recipeId}").` };
      }
      const fromRole = resolveRoleKey(colonyContext, callerAgentId, from_role);
      if (!fromRole) {
        return protocol.protocolViolation('Could not determine your role key. Pass from_role explicitly (e.g. "business_analyst").');
      }

      // The operator/orchestrator is NOT part of the handoff flow — handoff is a
      // worker tool. Redirect instead of recording a rejected handoff + violation.
      const flowRoles = new Set((protocol.getFlow(recipeId) || []).flatMap(e => [e.from, e.to]));
      if (!flowRoles.has(fromRole)) {
        return {
          error: `handoff is a worker tool — "${fromRole}" is not a role in the ${recipeId} flow. ` +
            `To advance work, call ask_agent for the target worker (use its agent_id); each worker calls handoff itself when its work is complete.`,
        };
      }

      // Rule of engagement: verify target + preconditions before acting.
      const check = protocol.checkPreconditions(colonyContext.colonyId, recipeId, fromRole, to_role);
      if (!check.ok) {
        // Record the rejected attempt for auditability and surface a clear protocol error.
        protocol.recordHandoff(colonyContext.colonyId, {
          fromRole, toRole: to_role, payload: { summary, ...payload },
          protocolStatus: check.protocol_status || 'precondition_failed', status: 'rejected',
        });
        protocol.writeBlackboard(colonyContext.colonyId, agentLabel(colonyContext, callerAgentId, fromRole), 'blocker',
          `Handoff ${fromRole}→${to_role} rejected: ${check.reason}`);
        return protocol.protocolViolation(check.reason, { from: fromRole, to: to_role, missing: check.missing });
      }

      const edge = check.edge;
      const requiresHuman = !!edge.requires_human;
      const historyRef = protocol.historyRefForAgent(callerAgentId);
      if (colonyContext?.agentHistories?.has(callerAgentId)) {
        try { protocol.persistAgentHistory(colonyContext.colonyId, callerAgentId, colonyContext.agentHistories.get(callerAgentId)); } catch (e) { logSwallowed('agentTools:persistHistory', e, { agentId: callerAgentId }); }
      }
      const commandObject = {
        target_agent: to_role,
        from: fromRole,
        contract: edge.payload,
        summary,
        payload,
        artifacts,
        history_ref: historyRef,
      };
      const record = protocol.recordHandoff(colonyContext.colonyId, {
        fromRole, toRole: to_role, payload: commandObject,
        protocolStatus: 'ok',
        requiresHuman,
        status: requiresHuman ? 'awaiting_human' : 'pending',
        historyRef,
      });

      const author = agentLabel(colonyContext, callerAgentId, fromRole);
      protocol.writeBlackboard(colonyContext.colonyId, author, 'message',
        `Handoff → ${to_role} (${edge.payload}): ${summary}`,
        { handoff_id: record.id, requires_human: requiresHuman });

      if (requiresHuman) {
        return {
          success: true,
          handoff_id: record.id,
          status: 'awaiting_human',
          requires_human: true,
          command: commandObject,
          message: `This is a critical handoff (${edge.payload}) and is HELD for human approval. Do not assume the next role has started. A reviewer must approve via the colony Handoffs panel before ${to_role} proceeds.`,
        };
      }

      // Auto-advance the colony plan: an accepted handoff is hard evidence that a
      // stage of work completed. Operators (especially small local models) routinely
      // forget update_plan_step, leaving the plan checklist frozen at "pending" for
      // the whole run — so the protocol drives plan progress deterministically.
      let updatedPlan = null;
      try {
        const planRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
        if (planRow?.plan) {
          const plan = JSON.parse(planRow.plan);
          const step = (plan.steps || []).find(s => s.status === 'in_progress')
            || (plan.steps || []).find(s => s.status === 'pending');
          if (step) {
            step.status = 'done';
            step.note = `auto-completed: handoff ${fromRole}→${to_role} accepted`;
            plan.updated_at = Date.now();
            db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
              .run(JSON.stringify(plan), colonyContext.colonyId);
            if (colonyContext.delegatedSteps) colonyContext.delegatedSteps.add(String(step.id));
            updatedPlan = plan;
          }
        }
      } catch (e) { logSwallowed('agentTools:planAdvance', e, { colonyId: colonyContext.colonyId }); }

      return {
        success: true,
        handoff_id: record.id,
        status: 'accepted',
        command: commandObject,
        ...(updatedPlan ? { plan: updatedPlan } : {}),
      };
    },
  },

  get_handoff_context: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'get_handoff_context',
        description: 'Fetch the full upstream conversation history for a handoff by id. Use only when the handoff summary/payload is not enough; normal operation should rely on the command object to save tokens.',
        parameters: {
          type: 'object',
          properties: {
            handoff_id: { type: 'string', description: 'The handoff_id from a handoff command object or ledger entry.' },
          },
          required: ['handoff_id'],
        },
      },
    },
    async handler({ handoff_id }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'get_handoff_context is only available inside a Colony run' };
      if (!handoff_id) return { error: 'handoff_id is required' };
      const context = protocol.getHandoffContext(handoff_id);
      if (context?.handoff && context.handoff.colony_id !== colonyContext.colonyId) {
        return { error: `Handoff "${handoff_id}" does not belong to this colony.` };
      }
      return context;
    },
  },

  request_assistance: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'request_assistance',
        description: 'ACP: ask the team for help when blocked, without breaking the handoff flow. Posts an assistance request to the Blackboard for the orchestrator or another role to pick up.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Short subject of what you need help with.' },
            detail: { type: 'string', description: 'Specifics of the blocker or question.' },
            to_role: { type: 'string', description: 'Optional role key best suited to help.' },
          },
          required: ['topic'],
        },
      },
    },
    async handler({ topic, detail, to_role }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'request_assistance is only available inside a Colony run' };
      const from = resolveRoleKey(colonyContext, callerAgentId) || 'agent';
      const author = agentLabel(colonyContext, callerAgentId);
      protocol.writeBlackboard(colonyContext.colonyId, author, 'assistance',
        `ASSISTANCE [${topic}]${to_role ? ` → ${to_role}` : ''}: ${detail || ''}`, { topic, to_role: to_role || null });
      return protocol.acpEnvelope('assistance', { from, to: to_role || null, performative: 'request', content: { topic, detail } });
    },
  },

  report_progress: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'report_progress',
        description: 'ACP: report progress on your current task to the Blackboard so the orchestrator can track status asynchronously.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Short status, e.g. "in_progress", "blocked", "done".' },
            detail: { type: 'string', description: 'What changed / what you are doing.' },
          },
          required: ['status'],
        },
      },
    },
    async handler({ status, detail }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'report_progress is only available inside a Colony run' };
      const from = resolveRoleKey(colonyContext, callerAgentId) || 'agent';
      const author = agentLabel(colonyContext, callerAgentId);
      protocol.writeBlackboard(colonyContext.colonyId, author, 'progress', `[${status}] ${detail || ''}`, { status });
      return protocol.acpEnvelope('progress', { from, performative: 'inform', content: { status, detail } });
    },
  },

  report_protocol_violation: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'report_protocol_violation',
        description: 'The "Not-Understood" act. If you receive a task or message you do not recognise or cannot handle with your role and tools, call this to gracefully report a protocol violation INSTEAD of hallucinating a response.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why you cannot handle this (unknown task, missing precondition, out of scope for your role).' },
          },
          required: ['reason'],
        },
      },
    },
    async handler({ reason }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'report_protocol_violation is only available inside a Colony run' };
      const from = resolveRoleKey(colonyContext, callerAgentId) || 'agent';
      const author = agentLabel(colonyContext, callerAgentId);
      protocol.writeBlackboard(colonyContext.colonyId, author, 'message', `PROTOCOL VIOLATION: ${reason}`, { violation: true });
      return protocol.protocolViolation(reason, { from });
    },
  },

  report_workaround: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'report_workaround',
        description: 'Record an issue that forced the colony to work around missing app capability, poor tooling, model weakness, access limits, or unclear workflow. Use this during the run so the final report can tell the user how to improve Hive for future colonies.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'The problem encountered.' },
            workaround: { type: 'string', description: 'What the operator/team did instead.' },
            recommendation: { type: 'string', description: 'Concrete app/product change that would make future agents perform better.' },
            impact: { type: 'string', description: 'How this affected quality, speed, confidence, or completeness.' },
          },
          required: ['issue', 'workaround', 'recommendation'],
        },
      },
    },
    async handler({ issue, workaround, recommendation, impact }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'report_workaround is only available inside a Colony run' };
      const note = {
        issue: String(issue || '').trim(),
        workaround: String(workaround || '').trim(),
        recommendation: String(recommendation || '').trim(),
        impact: impact ? String(impact).trim() : '',
      };
      if (!note.issue || !note.workaround || !note.recommendation) {
        return { error: 'issue, workaround, and recommendation are required' };
      }
      protocol.writeBlackboard(
        colonyContext.colonyId,
        'Operator',
        'message',
        `WORKAROUND: ${note.issue}\nUsed: ${note.workaround}\nImprove Hive: ${note.recommendation}${note.impact ? `\nImpact: ${note.impact}` : ''}`,
        { workaround_report: true, ...note },
      );
      return { success: true, workaround: note };
    },
  },

  report_acceptance: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'report_acceptance',
        description: 'Record a per-criterion verdict against the work item\'s acceptance criteria. QA MUST call this after executing its checks, before handing off. Each verdict needs the criterion text, pass/fail/not_verified, and the command output or observation used as evidence.',
        parameters: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              description: 'One entry per acceptance criterion.',
              items: {
                type: 'object',
                properties: {
                  criterion: { type: 'string', description: 'The acceptance criterion text (verbatim or close).' },
                  status: { type: 'string', enum: ['pass', 'fail', 'not_verified'], description: 'Verdict from executed checks.' },
                  evidence: { type: 'string', description: 'Command output or observation proving the verdict.' },
                },
                required: ['criterion', 'status'],
              },
            },
          },
          required: ['results'],
        },
      },
    },
    async handler({ results }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'report_acceptance is only available inside a Colony run' };
      if (!Array.isArray(results) || results.length === 0) return { error: 'results must be a non-empty array' };
      const normalized = results.map(r => ({
        criterion: String(r?.criterion || '').trim(),
        status: ['pass', 'fail', 'not_verified'].includes(r?.status) ? r.status : 'not_verified',
        evidence: r?.evidence ? String(r.evidence).slice(0, 600) : '',
      })).filter(r => r.criterion);
      if (normalized.length === 0) return { error: 'every result needs a criterion' };
      const author = agentLabel(colonyContext, callerAgentId, 'qa_engineer');
      protocol.writeBlackboard(
        colonyContext.colonyId,
        author,
        'state',
        `Acceptance criteria verdicts:\n${normalized.map(r => `- [${r.status.toUpperCase()}] ${r.criterion}`).join('\n')}`,
        { acceptance_results: normalized },
      );
      return { success: true, recorded: normalized.length, results: normalized };
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
      // Protocol recipes: accepted handoffs auto-advance the plan and are the
      // evidence of real work, so the strict in_progress/ordering/delegation
      // guards below only generate error ping-pong that burns the operator's
      // tool rounds (observed: ~15 of 20 rounds lost to guard errors). Apply
      // the transition directly and tell the operator the plan is auto-managed.
      const lenientProtocol = protocol.hasProtocol(colonyContext.recipeId);
      if (!lenientProtocol) {
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
      } // end !lenientProtocol guards
      if (lenientProtocol && colonyContext.delegatedSteps && status === 'done') {
        colonyContext.delegatedSteps.add(String(id));
      }
      step.status = status;
      if (note) step.note = String(note).slice(0, 500);
      plan.updated_at = Date.now();
      db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
        .run(JSON.stringify(plan), colonyContext.colonyId);
      
      // GitHub write-back: close issue if done
      if (status === 'done' && step.github_issue_number) {
        const colonyRow = db.prepare('SELECT github_writeback, repo_path FROM colonies WHERE id=?').get(colonyContext.colonyId);
        if (colonyRow?.github_writeback && colonyRow?.repo_path) {
          const detected = detectGitHubRepo(colonyRow.repo_path);
          if (detected) {
            updateGitHubIssue({
              owner: detected.owner,
              repo: detected.repo,
              number: step.github_issue_number,
              state: 'closed',
              comment: `✅ Task completed by Hive Colony.\n\n${step.note ? `**Note:** ${step.note}` : ''}`
            }).catch(err => {
              console.error('Failed to close GitHub issue:', err);
              protocol.writeBlackboard(colonyContext.colonyId, 'system', 'blocker',
                `Failed to update GitHub issue #${step.github_issue_number}: ${err.message}. Please check your token.`,
                { error: err.message }
              );
            });
          }
        }
      }

      return {
        success: true, step, plan,
        ...(lenientProtocol ? { note: 'Plan steps also auto-complete when handoffs are accepted — manual updates are only needed for blocked steps or extra work.' } : {}),
      };
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

      // Protocol gate: a protocol-driven colony cannot complete while a critical
      // handoff awaits human approval, or if the handoff flow was never used.
      const recipeId = colonyContext.recipeId;
      let deliverable = null;
      if (protocol.hasProtocol(recipeId)) {
        const completion = protocol.flowCompletion(colonyContext.colonyId, recipeId);
        if (!completion.ok) {
          return {
            error: `Cannot mark goal achieved: ${completion.reason}`,
            ...(completion.pending_human ? { pending_human: completion.pending_human } : {}),
          };
        }
        // Premature-victory guard: the dev-team flow must run END TO END before
        // the goal can be declared. Without this, an operator that delegated to
        // one role could self-complete the plan and finish with a "partial flow"
        // deliverable and no real work product.
        if (!completion.terminal_reached && Array.isArray(completion.missing_edges) && completion.missing_edges.length > 0) {
          return {
            error: `Cannot mark goal achieved: the handoff flow is incomplete. Missing handoffs: ` +
              `${completion.missing_edges.map(e => `${e.from}→${e.to} (${e.payload})`).join('; ')}. ` +
              `Delegate to each remaining role in order with ask_agent — every role must complete its work and hand off before the run can finish.`,
            missing_edges: completion.missing_edges,
          };
        }
        deliverable = protocol.buildDeliverable(colonyContext.colonyId, recipeId, trimmed);
      }
      const workaroundRows = protocol.readBlackboard(colonyContext.colonyId, { limit: 500 })
        .filter(entry => entry.meta?.workaround_report)
        .map(entry => ({
          issue: entry.meta.issue || entry.content,
          workaround: entry.meta.workaround || '',
          recommendation: entry.meta.recommendation || '',
          impact: entry.meta.impact || '',
        }));
      if (workaroundRows.length > 0) {
        deliverable = deliverable || { summary: trimmed, flow_complete: false, handoffs: [], artifacts: [], links: [] };
        deliverable.workarounds = workaroundRows;
      }

      db.prepare('UPDATE colonies SET summary=?, deliverable=?, updated_at=unixepoch() WHERE id=?')
        .run(trimmed, deliverable ? JSON.stringify(deliverable) : null, colonyContext.colonyId);
      return { success: true, goal_achieved: true, summary: trimmed, ...(deliverable ? { deliverable } : {}) };
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
    async handler({ pipeline_id, input }, { ollamaUrl, hivePath, signal }) {
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
        if (signal?.aborted) {
          const err = new Error('Pipeline run was stopped');
          err.name = 'AbortError';
          throw err;
        }
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
            prevOutput = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, hivePath, toolsOverride, undefined, signal);
          } catch (e) {
            if (e.name === 'AbortError' || signal?.aborted) throw e;
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
                const output = await runAgentOnce(agent, [{ role: 'user', content: prompt }], ollamaUrl, 0, null, hivePath, toolsOverride, undefined, signal);
                return { idx, output, error: null };
              } catch (e) {
                return { idx, output: null, error: e.message, aborted: e.name === 'AbortError' || signal?.aborted };
              }
            }),
          );
          const aborted = results.find(r => r.aborted);
          if (aborted) {
            const err = new Error('Pipeline run was stopped');
            err.name = 'AbortError';
            throw err;
          }
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
      const { stdout, exitCode } = await sandbox.exec(callerAgentId, cmd, 120_000);
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
      const dir      = sandbox.workspaceDir(callerAgentId);
      try {
        const resolved = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(filePath), { allowMissing: true });
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf8');
        return { success: true, path: filePath, bytes: content.length };
      } catch (e) {
        return { error: e.message };
      }
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
      const dir      = sandbox.workspaceDir(callerAgentId);
      try {
        const resolved = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(filePath), { allowMissing: false });
        const content = fs.readFileSync(resolved, 'utf8');
        return { content: content.slice(0, 16000), truncated: content.length > 16000 };
      } catch (e) {
        return { error: e.message };
      }
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
      const dir      = sandbox.workspaceDir(callerAgentId);
      try {
        const resolved = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(filePath), { allowMissing: false });
        fs.rmSync(resolved, { recursive: true, force: true });
        return { success: true, deleted: filePath };
      } catch (e) {
        return { error: e.message };
      }
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
      const dir       = sandbox.workspaceDir(callerAgentId);
      try {
        const srcRes = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(from), { allowMissing: false });
        const dstRes = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(to), { allowMissing: true });
        fs.mkdirSync(path.dirname(dstRes), { recursive: true });
        fs.renameSync(srcRes, dstRes);
        return { success: true, from, to };
      } catch (e) {
        return { error: e.message };
      }
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
      try {
        return { files: sandbox.listWorkspaceFiles(callerAgentId, stripWorkspacePrefix(directory), { maxDepth: 3, limit: 100 }) };
      } catch (e) {
        return { error: e.message };
      }
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
    .filter(t => {
      const groups = Array.isArray(t.groups) ? t.groups : [t.group];
      return groups.some(group => enabledGroups.includes(group));
    })
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

// Map of built-in tool group → list of { name, description } for every function
// in that group. Used by the Skills & Tools UI to show what each group exposes.
function builtInToolCatalog() {
  const catalog = {};
  for (const tool of Object.values(TOOLS)) {
    const groups = Array.isArray(tool.groups) ? tool.groups : [tool.group];
    for (const group of groups) {
      if (!group) continue;
      (catalog[group] ||= []).push({
        name: tool.definition?.function?.name || '',
        description: tool.definition?.function?.description || '',
      });
    }
  }
  return catalog;
}

module.exports = { getToolDefinitions, executeTool, runAgentOnce, readMemory, readShared, isPermissionError, builtInToolCatalog };
