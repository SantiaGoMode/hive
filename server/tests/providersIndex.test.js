// Direct tests for the provider dispatcher (server/lib/providers/index.js).
//
// providers.test.js covers the PURE adapters (parseModel, splitSystem, …).
// This file covers the dispatcher's own decision logic, which previously had no
// coverage (issue #43, blocks #37):
//   • gatewayConfig resolution — env vs DB vs default key
//   • keyFor / hasKey — env-first key resolution + env: references
//   • getModel routing — gateway-alias, cloud-via-gateway, direct-cloud, ollama,
//     and the two error paths (gateway unconfigured / cloud key missing)
//   • ensureAgentGatewayKey — off / no-budget / cached / mint-success / mint-fail
//   • streamChat abort race — pre-aborted signal and abort mid-stream both reject
//     with AbortError without consuming the (unstoppable) underlying request

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const db = require('../db');
const providers = require('../lib/providers');
const { invalidateSettingsCache } = require('../lib/config');
const configRouter = require('../routes/config');

const {
  gatewayConfig, keyFor, hasKey, getModel, ensureAgentGatewayKey, streamChat,
} = providers;

// ── Env / settings isolation ──────────────────────────────────────────────────
// Each test fully owns the env vars and app_settings rows the dispatcher reads,
// so order never matters and nothing leaks into the rest of the suite.

const ENV_KEYS = [
  'LLM_GATEWAY_URL', 'LLM_GATEWAY_KEY',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'TEST_SECRET_REF',
];
const SETTING_KEYS = [
  'llm_gateway_url', 'llm_gateway_key', 'ollama_url',
  'anthropic_api_key', 'openai_api_key', 'gemini_api_key',
];

let savedEnv;

function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  invalidateSettingsCache(key);
}
function clearSetting(key) {
  db.prepare('DELETE FROM app_settings WHERE key=?').run(key);
  invalidateSettingsCache(key);
}

function resetState() {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of SETTING_KEYS) clearSetting(k);
}

before(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
});
beforeEach(resetState);
after(() => {
  resetState();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ── gatewayConfig ──────────────────────────────────────────────────────────────

describe('gatewayConfig', () => {
  it('is disabled when neither env nor DB sets a url', () => {
    assert.deepEqual(gatewayConfig(), { enabled: false, url: '', key: '' });
  });

  it('reads url from the DB and falls back to the default key', () => {
    setSetting('llm_gateway_url', 'http://db-gw:4000/v1');
    const gw = gatewayConfig();
    assert.equal(gw.enabled, true);
    assert.equal(gw.url, 'http://db-gw:4000/v1');
    assert.equal(gw.key, 'sk-hive-gateway'); // default when no key configured
  });

  it('prefers env over the DB for both url and key', () => {
    setSetting('llm_gateway_url', 'http://db-gw:4000/v1');
    setSetting('llm_gateway_key', 'sk-db-key');
    process.env.LLM_GATEWAY_URL = 'http://env-gw:4000/v1';
    process.env.LLM_GATEWAY_KEY = 'sk-env-key';
    const gw = gatewayConfig();
    assert.equal(gw.url, 'http://env-gw:4000/v1');
    assert.equal(gw.key, 'sk-env-key');
  });

  it('resolves an env: reference stored as the DB key', () => {
    setSetting('llm_gateway_url', 'http://db-gw:4000/v1');
    setSetting('llm_gateway_key', 'env:TEST_SECRET_REF');
    process.env.TEST_SECRET_REF = 'sk-from-ref';
    assert.equal(gatewayConfig().key, 'sk-from-ref');
  });

  it('refreshes when gateway settings are invalidated', () => {
    setSetting('llm_gateway_url', 'http://first-gw:4000/v1');
    assert.equal(gatewayConfig().url, 'http://first-gw:4000/v1');

    setSetting('llm_gateway_url', 'http://second-gw:4000/v1');
    assert.equal(gatewayConfig().url, 'http://second-gw:4000/v1');
  });

  it('refreshes after config writes gateway settings', () => {
    assert.deepEqual(gatewayConfig(), { enabled: false, url: '', key: '' });
    configRouter._test.writeConfig({ llm_gateway_url: 'http://route-gw:4000/v1' });

    assert.equal(gatewayConfig().url, 'http://route-gw:4000/v1');
  });
});

// ── keyFor / hasKey ──────────────────────────────────────────────────────────

describe('keyFor', () => {
  it('returns null when neither env nor DB has a key', () => {
    assert.equal(keyFor('anthropic'), null);
  });

  it('reads a literal key from the DB setting', () => {
    setSetting('openai_api_key', 'sk-db-openai');
    assert.equal(keyFor('openai'), 'sk-db-openai');
  });

  it('prefers the env var over the DB setting', () => {
    setSetting('anthropic_api_key', 'sk-db-anthropic');
    process.env.ANTHROPIC_API_KEY = 'sk-env-anthropic';
    assert.equal(keyFor('anthropic'), 'sk-env-anthropic');
  });

  it('resolves an env: reference stored in the DB', () => {
    setSetting('gemini_api_key', 'env:TEST_SECRET_REF');
    process.env.TEST_SECRET_REF = 'sk-gemini-ref';
    assert.equal(keyFor('gemini'), 'sk-gemini-ref');
  });

  it('memoizes DB setting reads until invalidated', () => {
    setSetting('openai_api_key', 'sk-first-openai');
    assert.equal(keyFor('openai'), 'sk-first-openai');

    db.prepare('UPDATE app_settings SET value=? WHERE key=?').run('sk-second-openai', 'openai_api_key');
    assert.equal(keyFor('openai'), 'sk-first-openai');

    invalidateSettingsCache('openai_api_key');
    assert.equal(keyFor('openai'), 'sk-second-openai');
  });
});

describe('hasKey', () => {
  it('is always true for ollama (local, no key needed)', () => {
    assert.equal(hasKey('ollama'), true);
  });

  it('is true for any cloud provider when the gateway holds the keys', () => {
    setSetting('llm_gateway_url', 'http://gw:4000/v1');
    assert.equal(hasKey('anthropic'), true); // no anthropic key set, but gateway is on
  });

  it('reflects whether a direct cloud key is present when no gateway', () => {
    assert.equal(hasKey('openai'), false);
    setSetting('openai_api_key', 'sk-openai');
    assert.equal(hasKey('openai'), true);
  });
});

// ── getModel routing ──────────────────────────────────────────────────────────

describe('getModel', () => {
  it('throws a configuration error for a gateway alias when no gateway is set', () => {
    assert.throws(() => getModel('gateway', 'hive-smart'), /no LLM gateway is configured/i);
  });

  it('builds a model for a gateway alias when the gateway is configured', () => {
    setSetting('llm_gateway_url', 'http://gw:4000/v1');
    assert.ok(getModel('gateway', 'hive-smart')); // routed to the gateway pool
  });

  it('throws a clear error for a cloud provider with no key and no gateway', () => {
    assert.throws(() => getModel('anthropic', 'claude-sonnet-4-6'), /API key not set/i);
  });

  it('routes a cloud provider through the gateway without needing a direct key', () => {
    setSetting('llm_gateway_url', 'http://gw:4000/v1');
    assert.ok(getModel('openai', 'gpt-5')); // no openai key set; gateway carries it
  });

  it('builds a direct cloud model when a key is set and no gateway', () => {
    setSetting('anthropic_api_key', 'sk-anthropic');
    assert.ok(getModel('anthropic', 'claude-sonnet-4-6'));
  });

  it('always builds an ollama model (local, no key, no gateway involvement)', () => {
    assert.ok(getModel('ollama', 'llama3.1:8b'));
  });
});

// ── ensureAgentGatewayKey ──────────────────────────────────────────────────────

describe('ensureAgentGatewayKey', () => {
  let savedFetch;
  beforeEach(() => { savedFetch = global.fetch; });
  afterEach(() => { global.fetch = savedFetch; });

  it('returns null when the gateway is off', async () => {
    assert.equal(await ensureAgentGatewayKey({ id: 'a1', gateway_budget_usd: 10 }), null);
  });

  it('returns null when the agent has no budget', async () => {
    setSetting('llm_gateway_url', 'http://gw:4000/v1');
    assert.equal(await ensureAgentGatewayKey({ id: 'a1', gateway_budget_usd: 0 }), null);
  });

  it('returns the already-minted key without calling the gateway', async () => {
    setSetting('llm_gateway_url', 'http://gw:4000/v1');
    global.fetch = () => { throw new Error('should not be called'); };
    const key = await ensureAgentGatewayKey({ id: 'a1', gateway_budget_usd: 10, gateway_key: 'sk-existing' });
    assert.equal(key, 'sk-existing');
  });

  it('mints a virtual key, returns it, and persists it on the agent row', async () => {
    setSetting('llm_gateway_url', 'http://gw:4000/v1');
    db.prepare('INSERT INTO agents (id, name) VALUES (?, ?)').run('agent-mint', 'Minty');
    let calledUrl = null;
    global.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ key: 'sk-virtual-123' }) };
    };
    const agent = { id: 'agent-mint', name: 'Minty', gateway_budget_usd: 25 };
    const key = await ensureAgentGatewayKey(agent);
    assert.equal(key, 'sk-virtual-123');
    assert.equal(agent.gateway_key, 'sk-virtual-123'); // set in memory
    assert.match(calledUrl, /\/key\/generate$/);       // admin route, /v1 stripped
    const row = db.prepare('SELECT gateway_key FROM agents WHERE id=?').get('agent-mint');
    assert.equal(row.gateway_key, 'sk-virtual-123');   // persisted
  });

  it('returns null when the gateway rejects the mint request', async () => {
    setSetting('llm_gateway_url', 'http://gw:4000/v1');
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    assert.equal(await ensureAgentGatewayKey({ id: 'a2', gateway_budget_usd: 10 }), null);
  });

  it('returns null when the gateway is unreachable', async () => {
    setSetting('llm_gateway_url', 'http://gw:4000/v1');
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await ensureAgentGatewayKey({ id: 'a3', gateway_budget_usd: 10 }), null);
  });
});

// ── streamChat abort race ──────────────────────────────────────────────────────
// ai-sdk-ollama never forwards the abort signal to its HTTP client, so the
// dispatcher races each stream read against the signal and bails with AbortError.

describe('streamChat abort race', () => {
  let hangServer;
  let hangUrl;
  const sockets = new Set();

  before(async () => {
    // A server that accepts the connection and never responds — the only way out
    // of an in-flight read is the abort race itself.
    hangServer = http.createServer(() => { /* never end the response */ });
    hangServer.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((resolve) => hangServer.listen(0, '127.0.0.1', resolve));
    hangServer.unref(); // don't let the listener keep the process alive
    hangUrl = `http://127.0.0.1:${hangServer.address().port}`;
  });
  after(() => {
    // The dispatcher can't cancel the underlying socket (that's the bug it works
    // around), so the hung connection lingers — destroy it so the process exits.
    for (const s of sockets) s.destroy();
    hangServer.close();
  });

  it('throws AbortError immediately for an already-aborted signal', async () => {
    setSetting('ollama_url', hangUrl);
    const ctrl = new AbortController();
    ctrl.abort();
    const gen = streamChat('ollama/llama3.1:8b', {
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal,
    });
    await assert.rejects(() => gen.next(), (e) => e.name === 'AbortError');
  });

  it('rejects with AbortError when the signal aborts mid-stream', async () => {
    setSetting('ollama_url', hangUrl);
    const ctrl = new AbortController();
    const gen = streamChat('ollama/llama3.1:8b', {
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal,
    });
    const next = gen.next();                 // kicks off the hung request
    setTimeout(() => ctrl.abort(), 50);      // abort while the read is pending
    await assert.rejects(() => next, (e) => e.name === 'AbortError');
  });
});
