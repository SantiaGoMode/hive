const db = require('../db');

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

function normalizeOllamaUrl(value) {
  const raw = (value || DEFAULT_OLLAMA_URL).trim();
  const withoutTrailingSlash = raw.replace(/\/+$/, '');
  return withoutTrailingSlash.replace(/\/api$/i, '') || DEFAULT_OLLAMA_URL;
}

function getOllamaUrl() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='ollama_url'").get();
  return normalizeOllamaUrl(row?.value);
}

function ollamaApiUrl(pathname) {
  const path = String(pathname || '').replace(/^\/+/, '');
  return `${getOllamaUrl()}/api/${path}`;
}

module.exports = {
  DEFAULT_OLLAMA_URL,
  normalizeOllamaUrl,
  getOllamaUrl,
  ollamaApiUrl,
};
