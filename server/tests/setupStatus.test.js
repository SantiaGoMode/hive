// Setup wizard status (first-run dependency checks). The lib is tested with
// injected probes so no real Ollama/Docker/CLI is touched; the route test
// covers the setup_completed flag round-trip.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../db');
const { getSetupStatus } = require('../lib/setupStatus');
const { invalidateSettingsCache } = require('../lib/config');
const { makeApp } = require('./helpers/testApp');

const app = makeApp(require('../routes/system'), '/api/system');

function clearFlag() {
  db.prepare("DELETE FROM app_settings WHERE key='setup_completed'").run();
  invalidateSettingsCache();
}

after(clearFlag);

const fakeProbes = {
  ollama: async () => ({ reachable: true, url: 'http://x:11434', version: '0.9.0', installed_models: 2 }),
  docker: () => ({ docker: true, ready: false }),
  tool: async (cmd) => (cmd === 'uvx' ? { present: false } : { present: true, version: `${cmd} 1.0` }),
  githubToken: () => 'ghp_fake',
  keyFor: (p) => (p === 'anthropic' ? 'sk-ant-x' : ''),
  gateway: () => ({ configured: false, reachable: null }),
};

describe('setup status lib', () => {
  it('aggregates injected probes into the wizard shape', async () => {
    clearFlag();
    const s = await getSetupStatus(fakeProbes);
    assert.equal(s.setup_completed, false);
    assert.deepEqual(s.ollama, { reachable: true, url: 'http://x:11434', version: '0.9.0', installed_models: 2 });
    assert.deepEqual(s.docker, { available: true, sandbox_ready: false });
    assert.equal(s.git.present, true);
    assert.equal(s.gh.authenticated, true);
    assert.equal(s.uvx.present, false);
    assert.deepEqual(s.providers, { anthropic: true, openai: false, gemini: false });
    assert.equal(s.gateway.configured, false);
  });

  it('never throws when every probe fails', async () => {
    const boom = () => { throw new Error('probe exploded'); };
    const s = await getSetupStatus({
      ollama: boom, docker: boom, tool: boom, githubToken: boom, keyFor: boom, gateway: boom,
    });
    assert.equal(s.ollama.reachable, false);
    assert.equal(s.docker.available, false);
    assert.equal(s.git.present, false);
    assert.equal(s.gh.authenticated, false);
    assert.deepEqual(s.providers, { anthropic: false, openai: false, gemini: false });
  });
});

describe('setup routes', () => {
  it('POST /setup/complete flips the flag reported by the lib', async () => {
    clearFlag();
    assert.equal((await getSetupStatus(fakeProbes)).setup_completed, false);
    await request(app).post('/api/system/setup/complete').expect(200);
    assert.equal((await getSetupStatus(fakeProbes)).setup_completed, true);
  });
});
