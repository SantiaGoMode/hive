const db = require('../db');

const ENV_REF_RE = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

function parseEnvRef(value) {
  const match = typeof value === 'string' ? value.trim().match(ENV_REF_RE) : null;
  return match ? match[1] : null;
}

function resolveSecret(value) {
  const envName = parseEnvRef(value);
  if (envName) return (process.env[envName] || '').trim();
  return typeof value === 'string' ? value : '';
}

function settingValue(key) {
  try {
    return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value || '';
  } catch {
    return '';
  }
}

function settingSecret(key, envNames = []) {
  for (const envName of envNames) {
    const value = (process.env[envName] || '').trim();
    if (value) return value;
  }
  const stored = resolveSecret(settingValue(key)).trim();
  if (stored) return stored;
  return '';
}

function hasEnvSecret(envNames = []) {
  return envNames.some(name => !!(process.env[name] || '').trim());
}

module.exports = {
  parseEnvRef,
  resolveSecret,
  settingSecret,
  hasEnvSecret,
};
