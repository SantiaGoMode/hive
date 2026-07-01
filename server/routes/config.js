const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();
const db = require('../db');
const { invalidateSettingsCache } = require('../lib/config');
const { hasEnvSecret, parseEnvRef } = require('../lib/secrets');

const DASH_DIR = path.join(os.homedir(), '.hive');

// Secret settings are never returned in cleartext. The UI shows the mask and
// only sends a new value when the user actually edits the field.
const SECRET_KEYS = ['anthropic_api_key', 'openai_api_key', 'gemini_api_key', 'ngrok_authtoken', 'llm_gateway_key', 'hive_auth_token'];
const SECRET_ENV = {
  anthropic_api_key: ['ANTHROPIC_API_KEY'],
  openai_api_key: ['OPENAI_API_KEY'],
  gemini_api_key: ['GEMINI_API_KEY'],
  ngrok_authtoken: ['NGROK_AUTHTOKEN'],
  llm_gateway_key: ['LLM_GATEWAY_KEY'],
  hive_auth_token: ['HIVE_AUTH_TOKEN'],
};

function maskSecret(value) {
  if (!value) return '';
  if (parseEnvRef(value)) return value;
  return `••••••••${value.slice(-4)}`;
}

function isMasked(value) {
  return typeof value === 'string' && value.includes('•');
}

function readConfig() {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const out = {};
  for (const r of rows) out[r.key] = SECRET_KEYS.includes(r.key) ? maskSecret(r.value) : r.value;
  // Always advertise the secret keys (masked/empty) so the UI can render inputs.
  for (const k of SECRET_KEYS) if (!(k in out)) out[k] = '';
  for (const [key, envNames] of Object.entries(SECRET_ENV)) {
    if (!out[key] && hasEnvSecret(envNames)) out[key] = '••••••••env';
    out[`${key}_from_env`] = hasEnvSecret(envNames);
  }
  return out;
}

function clearStoredSecrets() {
  const stmt = db.prepare('DELETE FROM app_settings WHERE key = ?');
  for (const key of SECRET_KEYS) stmt.run(key);
  invalidateSettingsCache();
  return readConfig();
}

function writeConfig(body = {}) {
  const allowed = ['ollama_url', 'theme', 'accent_color', 'font_size', 'ngrok_authtoken', 'ngrok_domain', 'ngrok_enabled', 'webhook_public_url', 'llm_gateway_url', 'hive_allowed_origins', ...SECRET_KEYS];
  const stmt = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  let changed = false;
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    // Never persist a masked placeholder back over a real secret.
    if (SECRET_KEYS.includes(key) && isMasked(body[key])) continue;
    stmt.run(key, body[key]);
    changed = true;
  }
  if (changed) invalidateSettingsCache();
  return readConfig();
}

router.get('/', (req, res) => {
  res.json(readConfig());
});

router.put('/', (req, res) => {
  res.json(writeConfig(req.body));
});

router.delete('/secrets', (req, res) => {
  res.json(clearStoredSecrets());
});

router.delete('/shared-blackboard', (req, res) => {
  try {
    const sharedFile = path.join(DASH_DIR, 'shared', 'SHARED.md');
    if (fs.existsSync(sharedFile)) fs.writeFileSync(sharedFile, '', 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router._test = { readConfig, clearStoredSecrets, writeConfig };

module.exports = router;
