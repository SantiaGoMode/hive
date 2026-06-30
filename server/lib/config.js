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
//   LOG_LEVEL                     logger console level: debug|info|warn|error|silent (default info) — read in logger.js
//   LOG_SWALLOWED                 set to '0' to silence swallowed-error logs — read in logSwallowed.js
//   LLM_GATEWAY_URL / LLM_GATEWAY_KEY   LiteLLM gateway — resolved in providers/index.js gatewayConfig()
// Secrets (env wins over DB setting; resolved in secrets.js / providers):
//   ANTHROPIC_API_KEY · OPENAI_API_KEY · GEMINI_API_KEY · BRAVE_API_KEY · NGROK_AUTHTOKEN
//   GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN / GH_TOKEN — resolved by githubToken() below

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

function getSetting(key) {
  try {
    const db = require('../db'); // lazy: avoid a load-order dependency on db
    return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value || '';
  } catch {
    return '';
  }
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
function githubCliToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
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
};
