const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { checkOllamaStatus } = require('../routes/ollama');

function setOllamaUrl(url) {
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('ollama_url', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(url);
}

test('checkOllamaStatus reports reachable Ollama with models', async () => {
  const originalFetch = global.fetch;
  setOllamaUrl('http://ollama.test');
  global.fetch = async (url) => {
    assert.equal(url, 'http://ollama.test/api/tags');
    return {
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.2:3b' }] }),
    };
  };

  try {
    const status = await checkOllamaStatus();

    assert.equal(status.reachable, true);
    assert.equal(status.url, 'http://ollama.test');
    assert.deepEqual(status.models, [{ name: 'llama3.2:3b' }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('checkOllamaStatus reports unreachable Ollama without throwing', async () => {
  const originalFetch = global.fetch;
  setOllamaUrl('http://ollama.test');
  global.fetch = async () => {
    throw new Error('connect failed');
  };

  try {
    const status = await checkOllamaStatus();

    assert.equal(status.reachable, false);
    assert.equal(status.url, 'http://ollama.test');
    assert.equal(status.error, 'connect failed');
  } finally {
    global.fetch = originalFetch;
  }
});

test('checkOllamaStatus reports non-2xx Ollama responses as unreachable', async () => {
  const originalFetch = global.fetch;
  setOllamaUrl('http://ollama.test');
  global.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  });

  try {
    const status = await checkOllamaStatus();

    assert.equal(status.reachable, false);
    assert.equal(status.status, 500);
    assert.equal(status.error, 'Ollama responded with 500');
  } finally {
    global.fetch = originalFetch;
  }
});
