const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const configRouter = require('../routes/config');
const { resolveSecret, settingSecret } = require('../lib/secrets');
const mcpManager = require('../lib/mcpClient');

describe('secret references', () => {
  const originalEnv = {
    HIVE_TEST_SECRET: process.env.HIVE_TEST_SECRET,
    NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
  };

  afterEach(() => {
    db.prepare("DELETE FROM app_settings WHERE key IN ('ngrok_authtoken', 'openai_api_key')").run();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves env:NAME references without exposing missing values as literals', () => {
    process.env.HIVE_TEST_SECRET = 'resolved-value';

    assert.equal(resolveSecret('env:HIVE_TEST_SECRET'), 'resolved-value');
    assert.equal(resolveSecret('env:DOES_NOT_EXIST'), '');
    assert.equal(resolveSecret('literal-secret'), 'literal-secret');
  });

  it('prefers known environment secrets over stored setting values', () => {
    process.env.NGROK_AUTHTOKEN = 'env-ngrok-token';
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run('ngrok_authtoken', 'stored-ngrok-token');

    assert.equal(settingSecret('ngrok_authtoken', ['NGROK_AUTHTOKEN']), 'env-ngrok-token');
  });

  it('clears locally stored secrets while preserving env-provided status', async () => {
    process.env.NGROK_AUTHTOKEN = 'env-ngrok-token';
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run('ngrok_authtoken', 'stored-ngrok-token');
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run('openai_api_key', 'stored-openai-key');

    const out = configRouter._test.clearStoredSecrets();

    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='ngrok_authtoken'").get(), undefined);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='openai_api_key'").get(), undefined);
    assert.equal(out.ngrok_authtoken, '••••••••env');
    assert.equal(out.ngrok_authtoken_from_env, true);
  });
});

describe('LLM gateway settings', () => {
  const originalKey = process.env.LLM_GATEWAY_KEY;

  afterEach(() => {
    db.prepare("DELETE FROM app_settings WHERE key IN ('llm_gateway_url', 'llm_gateway_key')").run();
    if (originalKey === undefined) delete process.env.LLM_GATEWAY_KEY;
    else process.env.LLM_GATEWAY_KEY = originalKey;
  });

  it('masks the gateway key but exposes the gateway url in plaintext', () => {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run('llm_gateway_url', 'http://127.0.0.1:4000/v1');
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run('llm_gateway_key', 'sk-secret-virtual-key');

    const out = configRouter._test.readConfig();
    assert.equal(out.llm_gateway_url, 'http://127.0.0.1:4000/v1');
    assert.match(out.llm_gateway_key, /^••••••••/);
    assert.ok(!out.llm_gateway_key.includes('virtual-key'));
  });

  it('reports the gateway key as env-provided when set via LLM_GATEWAY_KEY', () => {
    process.env.LLM_GATEWAY_KEY = 'env-virtual-key';
    const out = configRouter._test.readConfig();
    assert.equal(out.llm_gateway_key_from_env, true);
  });
});

describe('MCP secret env handling', () => {
  const original = process.env.HIVE_TEST_MCP_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.HIVE_TEST_MCP_KEY;
    else process.env.HIVE_TEST_MCP_KEY = original;
  });

  it('resolves env references before spawning MCP stdio servers', () => {
    process.env.HIVE_TEST_MCP_KEY = 'mcp-secret-value';

    const out = mcpManager._test.resolveEnv({
      BRAVE_API_KEY: 'env:HIVE_TEST_MCP_KEY',
      PLAIN_VALUE: 'visible',
    });

    assert.deepEqual(out, {
      BRAVE_API_KEY: 'mcp-secret-value',
      PLAIN_VALUE: 'visible',
    });
  });

  it('masks literal MCP secrets in status but leaves env references visible', () => {
    const out = mcpManager._test.maskEnvForStatus({
      BRAVE_API_KEY: 'env:BRAVE_API_KEY',
      GITHUB_TOKEN: 'literal-token',
      PLAIN_VALUE: 'visible',
    }, ['BRAVE_API_KEY', 'GITHUB_TOKEN']);

    assert.equal(out.BRAVE_API_KEY, 'env:BRAVE_API_KEY');
    assert.equal(out.GITHUB_TOKEN, '••••••••');
    assert.equal(out.PLAIN_VALUE, 'visible');
  });
});
