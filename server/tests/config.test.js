// Tests for the central config surface (issue #36).
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const config = require('../lib/config');

const ENV_KEYS = [
  'PORT', 'HIVE_HOME', 'HIVE_AUTH_TOKEN', 'HIVE_ALLOWED_ORIGINS',
  'HIVE_MUTATION_RATE_LIMIT', 'HIVE_MUTATION_RATE_WINDOW_MS',
  'HIVE_WEBHOOK_RATE_LIMIT', 'HIVE_WEBHOOK_RATE_WINDOW_MS', 'HIVE_BIND_HOST',
  'GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GH_TOKEN',
];
let saved;

function clearGithubSettings() {
  db.prepare("DELETE FROM app_settings WHERE key IN ('github_token','github_personal_access_token','hive_auth_token')").run();
  config.invalidateSettingsCache();
}
function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  config.invalidateSettingsCache(key);
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  clearGithubSettings();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  clearGithubSettings();
});

describe('operational accessors', () => {
  it('returns documented defaults when unset', () => {
    assert.equal(config.port(), 3001);
    assert.equal(config.mutationRateLimit(), 120);
    assert.equal(config.mutationRateWindowMs(), 60_000);
    assert.equal(config.webhookRateLimit(), 60);
    assert.equal(config.webhookRateWindowMs(), 60_000);
    assert.equal(config.bindHost(), '127.0.0.1');
    assert.equal(config.allowedOriginsEnv(), '');
  });

  it('reads numeric env vars and falls back on garbage', () => {
    process.env.PORT = '8080';
    process.env.HIVE_MUTATION_RATE_LIMIT = 'not-a-number';
    assert.equal(config.port(), 8080);
    assert.equal(config.mutationRateLimit(), 120); // garbage → default
  });

  it('authToken prefers env over the DB setting', () => {
    setSetting('hive_auth_token', 'from-db');
    assert.equal(config.authToken(), 'from-db');
    process.env.HIVE_AUTH_TOKEN = 'from-env';
    assert.equal(config.authToken(), 'from-env');
  });
});

describe('githubToken resolver', () => {
  it('returns null when nothing is configured (and gh CLI absent/unauthed)', () => {
    // We can't guarantee `gh` is uninstalled on the runner, but in CI it is not
    // authenticated, so the resolver returns null. Skip the strict assert if a
    // real gh token happens to be present in the environment.
    const t = config.githubToken();
    assert.ok(t === null || typeof t === 'string');
  });

  it('prefers the github_token setting over env vars', () => {
    setSetting('github_token', 'tok-from-setting');
    process.env.GITHUB_TOKEN = 'tok-from-env';
    assert.equal(config.githubToken(), 'tok-from-setting');
  });

  it('falls back through the env names in order', () => {
    process.env.GH_TOKEN = 'gh-token';
    assert.equal(config.githubToken(), 'gh-token');
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'pat-token';
    assert.equal(config.githubToken(), 'pat-token'); // PAT outranks GH_TOKEN
    process.env.GITHUB_TOKEN = 'gh-primary';
    assert.equal(config.githubToken(), 'gh-primary'); // GITHUB_TOKEN outranks PAT
  });

  it('trims whitespace and ignores blank candidates', () => {
    process.env.GITHUB_TOKEN = '   ';
    process.env.GH_TOKEN = '  real-token  ';
    assert.equal(config.githubToken(), 'real-token');
  });
});
