// Agent-management tools (list/get/create/update/delete). Split from agentTools.js (#27).
const { listAgents, readAgent, writeAgent, deleteAgent } = require('../agentParser');
const db = require('../../db');
const { logSwallowed } = require('../logSwallowed');
const { validateAgentModel } = require('./shared');

module.exports = {
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
      const { listAllModels } = require('../providers/listModels');
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
                  ? `- You have a sandbox: use write_file to save documents, run_python/shell to execute code.`
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

};
