// Pipeline-management tools (list/create/run). Split from agentTools.js (#27).
const { readAgent } = require('../agentParser');
const db = require('../../db');
// Lazy to avoid a load-time cycle with agentRunner (which requires the registry).
const runAgentOnce = (...a) => require('../agentRunner').runAgentOnce(...a);

module.exports = {
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

};
