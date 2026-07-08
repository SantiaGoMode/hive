const fs = require('fs');
const path = require('path');

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeTokenFile(filePath, token, log = () => {}) {
  if (!token) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${token}\n`, { mode: 0o600 });
  } catch (e) {
    log(`auth token convenience-file sync failed: ${e.message}`);
  }
}

function loadBetterSqlite3({ isPackaged = false, resourcesPath = '', log = () => {} } = {}) {
  if (isPackaged && resourcesPath) {
    try {
      return require(path.join(resourcesPath, 'node_modules', 'better-sqlite3'));
    } catch (e) {
      log(`packaged better-sqlite3 load failed: ${e.message}`);
    }
  }

  try {
    return require('better-sqlite3');
  } catch (e) {
    log(`better-sqlite3 load failed: ${e.message}`);
    return null;
  }
}

function readDbAuthToken({ dbPath, isPackaged = false, resourcesPath = '', log = () => {} } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return '';
  const Database = loadBetterSqlite3({ isPackaged, resourcesPath, log });
  if (!Database) return '';

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return String(
      db.prepare("SELECT value FROM app_settings WHERE key='hive_auth_token'").get()?.value || '',
    ).trim();
  } catch (e) {
    log(`auth token DB read failed: ${e.message}`);
    return '';
  } finally {
    try { db?.close(); } catch { /* ignore close failures */ }
  }
}

function readAuthToken({
  hiveHome,
  dbPath,
  env = process.env,
  isPackaged = false,
  resourcesPath = '',
  log = () => {},
} = {}) {
  const envToken = String(env.HIVE_AUTH_TOKEN || '').trim();
  if (envToken) return envToken;

  const tokenFile = path.join(hiveHome, 'auth_token');
  const dbToken = readDbAuthToken({ dbPath, isPackaged, resourcesPath, log });
  if (dbToken) {
    const fileToken = readText(tokenFile);
    if (fileToken !== dbToken) writeTokenFile(tokenFile, dbToken, log);
    return dbToken;
  }

  return readText(tokenFile);
}

module.exports = {
  readAuthToken,
  readDbAuthToken,
};
