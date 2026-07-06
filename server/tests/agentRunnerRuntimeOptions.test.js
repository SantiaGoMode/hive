const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../lib/providers');
const { runAgentOnce } = require('../lib/agentRunner');

describe('runAgentOnce runtime model options', () => {
  it('passes the agent temperature, output limit, and context length to the provider', async () => {
    const originalStreamChat = providers.streamChat;
    let seen;

    providers.streamChat = async function* streamChat(model, opts) {
      seen = { model, opts };
      yield { type: 'content', delta: 'done' };
      yield { type: 'done', reason: 'stop' };
    };

    try {
      const agent = {
        id: 'agent-1',
        name: 'Runtime Agent',
        model: 'fake-model',
        tools: [],
        system_prompt: 'Do the task.',
        temperature: 0.35,
        max_tokens: 1234,
        context_length: 5678,
      };

      const output = await runAgentOnce(
        agent,
        [{ role: 'user', content: 'hello' }],
        'http://unused-ollama',
        0,
        null,
        null,
        null,
        1,
        null,
        {
          colonyId: 'colony-1',
          reasoningByAgentId: new Map([['agent-1', true]]),
          roleByAgentId: new Map([['agent-1', 'project_manager']]),
        },
      );

      assert.equal(output, 'done');
      assert.equal(seen.model, 'fake-model');
      assert.equal(seen.opts.options.temperature, 0.35);
      assert.equal(seen.opts.options.num_predict, 1234);
      assert.equal(seen.opts.options.num_ctx, 5678);
      assert.equal(seen.opts.options.reasoning, true);
      assert.deepEqual(seen.opts.options.metadata, {
        agent_id: 'agent-1',
        agent_name: 'Runtime Agent',
        colony_id: 'colony-1',
        role: 'project_manager',
        source: 'colony',
      });
    } finally {
      providers.streamChat = originalStreamChat;
    }
  });
});
