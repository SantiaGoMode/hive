const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('./config');
const { logger } = require('./logger');

const KEEP_BACKUPS = Math.max(1, Number(process.env.HIVE_BACKUP_RETENTION) || 7);
const INTERVAL_MS = Math.max(60 * 60 * 1000, Number(process.env.HIVE_BACKUP_INTERVAL_HOURS || 24) * 60 * 60 * 1000);
let timer = null;

function backupDir() {
  const dir = path.join(config.hiveHome(), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function listBackups() {
  return fs.readdirSync(backupDir())
    .filter(name => /^hive-\d{8}T\d{6}Z\.db$/.test(name))
    .map(name => {
      const stat = fs.statSync(path.join(backupDir(), name));
      return { name, bytes: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function pruneBackups() {
  for (const item of listBackups().slice(KEEP_BACKUPS)) {
    fs.rmSync(path.join(backupDir(), item.name), { force: true });
  }
}

async function createBackup() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const name = `hive-${stamp}.db`;
  const destination = path.join(backupDir(), name);
  await db.backup(destination);
  try { fs.chmodSync(destination, 0o600); } catch { /* Windows */ }
  pruneBackups();
  return listBackups().find(item => item.name === name);
}

function integrityCheck() {
  const rows = db.pragma('quick_check');
  const messages = rows.map(row => Object.values(row)[0]);
  return { ok: messages.length === 1 && messages[0] === 'ok', messages };
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    createBackup()
      .then(backup => logger.info('database', 'backup_created', { name: backup?.name, bytes: backup?.bytes }))
      .catch(error => logger.error('database', 'backup_failed', { error: error.message }));
  }, INTERVAL_MS);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { createBackup, integrityCheck, listBackups, start, stop };
