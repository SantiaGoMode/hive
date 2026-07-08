const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { readAuthToken } = require('../../desktop/authToken');

function makeHiveHome() {
  const hiveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-desktop-auth-'));
  const dbPath = path.join(hiveHome, 'hive.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  db.close();
  return { hiveHome, dbPath };
}

function setDbToken(dbPath, token) {
  const db = new Database(dbPath);
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('hive_auth_token', token);
  db.close();
}

test('desktop auth token resolver prefers the DB token over a stale token file', () => {
  const { hiveHome, dbPath } = makeHiveHome();
  const tokenFile = path.join(hiveHome, 'auth_token');
  fs.writeFileSync(tokenFile, 'stale-file-token\n');
  setDbToken(dbPath, 'db-token');

  const token = readAuthToken({ hiveHome, dbPath, env: {} });

  assert.equal(token, 'db-token');
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), 'db-token\n');
});

test('desktop auth token resolver falls back to auth_token when DB token is unavailable', () => {
  const { hiveHome, dbPath } = makeHiveHome();
  fs.writeFileSync(path.join(hiveHome, 'auth_token'), 'file-token\n');

  assert.equal(readAuthToken({ hiveHome, dbPath, env: {} }), 'file-token');
});

test('desktop auth token resolver keeps HIVE_AUTH_TOKEN authoritative', () => {
  const { hiveHome, dbPath } = makeHiveHome();
  fs.writeFileSync(path.join(hiveHome, 'auth_token'), 'file-token\n');
  setDbToken(dbPath, 'db-token');

  assert.equal(
    readAuthToken({ hiveHome, dbPath, env: { HIVE_AUTH_TOKEN: 'env-token' } }),
    'env-token',
  );
});
