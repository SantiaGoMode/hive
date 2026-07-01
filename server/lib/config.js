// Central config surface (issue #36).
//
// One documented place for the server's environment variables, plus the
// canonical GitHub-token resolver. This covers OPERATIONAL config (ports, dirs,
// CORS, rate limits) and cross-cutting lookups. Cloud-provider SECRETS keep
// their env-wins-over-DB resolution in secrets.js / providers/index.js — this
// module doesn't duplicate that — but every env var the server reads is
// inventoried below and in .env.example.
//
// ── Environment variable inventory ────────────────────────────────────────────
// Operational (non-secret):
//   PORT                          HTTP port (default 3001)
//   HIVE_HOME                     data dir (default ~/.hive)
//   HIVE_DB_PATH                  sqlite path (default <HIVE_HOME>/hive.db) — read in db.js at load
//   HIVE_ALLOWED_ORIGINS          extra allowed CORS/WS origins (comma-separated)
//   HIVE_AUTH_TOKEN               API auth token (else the hive_auth_token setting)
//   HIVE_MUTATION_RATE_LIMIT      mutating-request cap per window (default 120)
//   HIVE_MUTATION_RATE_WINDOW_MS  rate window in ms (default 60000)
//   HIVE_SANDBOX_NETWORK          sandbox container network: none (default) | bridge — read in sandbox.js
//   LOG_LEVEL                     logger console level: debug|info|warn|error|silent (default info) — read in logger.js
//   LOG_SWALLOWED                 set to '0' to silence swallowed-error logs — read in logSwallowed.js
//   LLM_GATEWAY_URL / LLM_GATEWAY_KEY   LiteLLM gateway — resolved in providers/index.js gatewayConfig()
// Secrets (env wins over DB setting; resolved in secrets.js / providers):
//   ANTHROPIC_API_KEY · OPENAI_API_KEY · GEMINI_API_KEY · BRAVE_API_KEY · NGROK_AUTHTOKEN
//   GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN / GH_TOKEN — resolved by githubToken() below

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const settingsCache = new Map();
const settingsInvalidationListeners = new Set();

function getSetting(key, fallback = '') {
  if (settingsCache.has(key)) return settingsCache.get(key);
  try {
    const db = require('../db'); // lazy: avoid a load-order dependency on db
    const value = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value ?? fallback;
    settingsCache.set(key, value);
    return value;
  } catch {
    return fallback;
  }
}

function invalidateSettingsCache(key = null) {
  if (key) settingsCache.delete(key);
  else settingsCache.clear();
  for (const listener of settingsInvalidationListeners) {
    try { listener(key); } catch { /* cache invalidation listeners are best-effort */ }
  }
}

function onSettingsCacheInvalidated(listener) {
  settingsInvalidationListeners.add(listener);
  return () => settingsInvalidationListeners.delete(listener);
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// ── Operational accessors ──────────────────────────────────────────────────────
function port() { return num(process.env.PORT, 3001); }
function hiveHome() { return process.env.HIVE_HOME || path.join(os.homedir(), '.hive'); }
function allowedOriginsEnv() { return process.env.HIVE_ALLOWED_ORIGINS || ''; }
function authToken() { return process.env.HIVE_AUTH_TOKEN || getSetting('hive_auth_token') || ''; }
function mutationRateLimit() { return num(process.env.HIVE_MUTATION_RATE_LIMIT, 120); }
function mutationRateWindowMs() { return num(process.env.HIVE_MUTATION_RATE_WINDOW_MS, 60_000); }

// ── GitHub token ────────────────────────────────────────────────────────────────
// Canonical resolver: stored settings first, then the conventional env var
// names in order, then the GitHub CLI (`gh auth token`). Returns null if none.
// `gh auth token` shells out and can stall the event loop; cache the result
// with a short TTL since CLI tokens change rarely.
const GH_CLI_TOKEN_TTL = 60_000; // ms
let _ghCliTokenCache = null; // { at, value }

function githubCliToken() {
  const now = Date.now();
  if (_ghCliTokenCache && now - _ghCliTokenCache.at < GH_CLI_TOKEN_TTL) return _ghCliTokenCache.value;
  let value = '';
  try {
    value = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    value = '';
  }
  _ghCliTokenCache = { at: now, value };
  return value;
}

function githubToken() {
  const candidates = [
    getSetting('github_token'),
    getSetting('github_personal_access_token'),
    process.env.GITHUB_TOKEN,
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    process.env.GH_TOKEN,
    githubCliToken(),
  ];
  return candidates.find(v => typeof v === 'string' && v.trim())?.trim() || null;
}

module.exports = {
  port,
  hiveHome,
  allowedOriginsEnv,
  authToken,
  mutationRateLimit,
  mutationRateWindowMs,
  githubToken,
  githubCliToken,
  getSetting,
  invalidateSettingsCache,
  onSettingsCacheInvalidated,
};
