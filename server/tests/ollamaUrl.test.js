const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { normalizeOllamaUrl, getOllamaUrl, ollamaApiUrl } = require('../lib/ollamaUrl');
const providers = require('../lib/providers');

describe('Ollama URL normalization', () => {
  beforeEach(() => {
    db.prepare("UPDATE app_settings SET value=? WHERE key='ollama_url'").run('http://localhost:11434');
  });

  it('accepts both root and /api Ollama URLs', () => {
    assert.equal(normalizeOllamaUrl('http://localhost:11434'), 'http://localhost:11434');
    assert.equal(normalizeOllamaUrl('http://localhost:11434/'), 'http://localhost:11434');
    assert.equal(normalizeOllamaUrl('http://localhost:11434/api'), 'http://localhost:11434');
    assert.equal(normalizeOllamaUrl('http://localhost:11434/api/'), 'http://localhost:11434');
  });

  it('builds exactly one /api prefix for direct Ollama calls', () => {
    db.prepare("UPDATE app_settings SET value=? WHERE key='ollama_url'").run('http://ollama.test:11434/api/');

    assert.equal(getOllamaUrl(), 'http://ollama.test:11434');
    assert.equal(ollamaApiUrl('/tags'), 'http://ollama.test:11434/api/tags');
  });

  it('passes the Ollama root URL to ai-sdk-ollama', () => {
    db.prepare("UPDATE app_settings SET value=? WHERE key='ollama_url'").run('http://ollama.test:11434/api/');

    const model = providers.getModel('ollama', 'qwen3:8b');
    const hostUrl = new URL(model.config.client.config.host);
    assert.equal(hostUrl.pathname, '/');
  });
});
