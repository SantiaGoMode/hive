const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../db');
const { executeTool, getToolDefinitions } = require('../lib/agentTools');
const { invalidateSettingsCache } = require('../lib/config');
const { createColony, deleteColony } = require('../lib/colonyRunner');
const { buildEnvelope } = require('../lib/webhookProjection');

const ORIGINAL_ENV = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

function setCloudKeys() {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
}

function restoreCloudKeys() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('create_agent model handling', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    restoreCloudKeys();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreCloudKeys();
  });

  it('accepts bare and ollama-prefixed local model ids after checking Ollama tags', async () => {
    global.fetch = async (url) => {
      assert.equal(url, 'http://ollama.test/api/tags');
      return {
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen3:latest' }] }),
      };
    };

    const bare = await executeTool('create_agent', {
      name: 'local-bare',
      model: 'llama3.1:8b',
    }, null, 'http://ollama.test');
    assert.equal(bare.success, true);
    assert.equal(bare.agent.model, 'llama3.1:8b');

    const prefixed = await executeTool('create_agent', {
      name: 'local-prefixed',
      model: 'ollama/qwen3',
    }, null, 'http://ollama.test');
    assert.equal(prefixed.success, true);
    assert.equal(prefixed.agent.model, 'ollama/qwen3');
  });

  it('accepts cloud-prefixed model ids when the provider key is configured', async () => {
    setCloudKeys();
    global.fetch = async () => {
      throw new Error('cloud model validation must not call Ollama tags');
    };

    const cases = [
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-5',
      'gemini/gemini-2.5-pro',
      'anthropic/custom-model-id',
    ];

    for (const model of cases) {
      const out = await executeTool('create_agent', {
        name: `agent-${model.replace(/[^a-z0-9]+/gi, '-')}`,
        model,
        tools: ['agent_tools'],
      }, null, 'http://ollama.test');
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.agent.model, model);
      assert.deepEqual(out.agent.tools, ['agent_tools']);
    }
  });

  it('returns a clear error for cloud models without a provider key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    global.fetch = async () => {
      throw new Error('cloud model validation must not call Ollama tags');
    };

    const out = await executeTool('create_agent', {
      name: 'missing-key-agent',
      model: 'anthropic/claude-sonnet-4-6',
    }, null, 'http://ollama.test');

    assert.match(out.error, /Anthropic API key is not set/);
  });

  it('accepts cloud model ids from env: provider key settings', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.HIVE_TEST_ANTHROPIC_KEY = 'test-anthropic-from-ref';
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run('anthropic_api_key', 'env:HIVE_TEST_ANTHROPIC_KEY');
    invalidateSettingsCache('anthropic_api_key');
    global.fetch = async () => {
      throw new Error('cloud model validation must not call Ollama tags');
    };

    const out = await executeTool('create_agent', {
      name: 'env-ref-agent',
      model: 'anthropic/claude-sonnet-4-6',
    }, null, 'http://ollama.test');

    assert.equal(out.success, true, JSON.stringify(out));
    db.prepare('DELETE FROM app_settings WHERE key=?').run('anthropic_api_key');
    invalidateSettingsCache('anthropic_api_key');
    delete process.env.HIVE_TEST_ANTHROPIC_KEY;
  });

  it('prefers process env provider keys over locally stored settings', async () => {
    const providers = require('../lib/providers');
    process.env.OPENAI_API_KEY = 'env-openai-key';
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run('openai_api_key', 'stored-openai-key');
    invalidateSettingsCache('openai_api_key');

    assert.equal(providers.keyFor('openai'), 'env-openai-key');
    db.prepare('DELETE FROM app_settings WHERE key=?').run('openai_api_key');
    invalidateSettingsCache('openai_api_key');
  });
});

describe('webhook event access through agent_tools', () => {
  it('exposes get_webhook_event and fetches the raw payload behind a projected envelope', async () => {
    const payload = {
      repository: { full_name: 'acme/api' },
      pusher: { name: 'cris' },
      hidden: { large: true },
    };
    const eventId = `evt_${Date.now()}`;
    const webhookId = `wh_${Date.now()}`;

    db.prepare('INSERT INTO webhooks (id, name, context_spec) VALUES (?, ?, ?)')
      .run(webhookId, 'Agent Tool Webhook', JSON.stringify([{ label: 'repo', path: 'repository.full_name' }]));
    db.prepare('INSERT INTO webhook_events (id, webhook_id, event_type, payload, headers) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, webhookId, 'push', JSON.stringify(payload), JSON.stringify({ 'x-github-event': 'push' }));

    const envelope = buildEnvelope(
      [{ label: 'repo', path: 'repository.full_name' }],
      { id: eventId, event_type: 'push', payload },
    );
    assert.deepEqual(envelope.context, { repo: 'acme/api' });
    assert.equal(envelope._projected, true);

    const definitions = getToolDefinitions(['agent_tools']);
    assert.ok(definitions.some(def => def.function?.name === 'get_webhook_event'));

    const raw = await executeTool('get_webhook_event', { event_id: envelope._event_id, include_headers: true });
    assert.equal(raw.event_type, 'push');
    assert.deepEqual(raw.payload, payload);
    assert.equal(raw.headers['x-github-event'], 'push');
  });
});

describe('project_context protocol tool', () => {
  it('exposes linked work-item context and local source docs to colony workers', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-context-'));
    const prdPath = path.join(repoPath, 'PRD.md');
    fs.writeFileSync(prdPath, '# Product Requirements\n\nUse GitHub issue acceptance criteria.', 'utf8');

    let colonyId = null;
    try {
      const boardCard = {
        number: 3,
        title: 'Define Technical Stack & Environment Setup',
        html_url: 'https://github.com/SantiaGoMode/Hive-TaskMaster/issues/3',
      };
      colonyId = createColony(
        'Implement issue #3',
        'qwen3:8b',
        'development_team',
        { repoPath, boardCard },
      );

      const definitions = getToolDefinitions(['protocol']);
      assert.ok(definitions.some(def => def.function?.name === 'project_context'));

      const result = await executeTool(
        'project_context',
        {},
        null,
        'http://ollama.test',
        0,
        null,
        null,
        null,
        4,
        null,
        { colonyId },
      );

      assert.equal(result.goal, 'Implement issue #3');
      assert.equal(result.repo_path, repoPath);
      assert.equal(result.board_card.number, 3);
      assert.match(result.board_card.html_url, /Hive-TaskMaster\/issues\/3/);
      assert.equal(result.source_files.length, 1);
      assert.equal(result.source_files[0].path, 'PRD.md');
      assert.match(result.source_files[0].content, /Product Requirements/);
    } finally {
      if (colonyId) deleteColony(colonyId);
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
