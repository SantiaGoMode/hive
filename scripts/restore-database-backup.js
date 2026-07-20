#!/usr/bin/env node
// Offline restore utility. Hive must be stopped so no process can keep writing
// the old WAL while the database file is replaced.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const name = process.argv[2] || '';
const confirmed = process.argv.includes('--confirm-stopped');
if (!/^hive-\d{8}T\d{6}Z\.db$/.test(name) || !confirmed) {
  console.error('Usage: npm run db:restore -- <backup-name> --confirm-stopped');
  console.error('Stop Hive first. Backup names are listed by GET /api/system/database/backups.');
  process.exit(2);
}

const hiveHome = process.env.HIVE_HOME || path.join(os.homedir(), '.hive');
const dbPath = process.env.HIVE_DB_PATH || path.join(hiveHome, 'hive.db');
const source = path.join(hiveHome, 'backups', name);
if (!fs.existsSync(source)) throw new Error(`Backup not found: ${name}`);

const candidate = new Database(source, { readonly: true, fileMustExist: true });
try {
  const result = candidate.pragma('quick_check').map(row => Object.values(row)[0]);
  if (result.length !== 1 || result[0] !== 'ok') throw new Error(`Backup failed quick_check: ${result.join('; ')}`);
} finally {
  candidate.close();
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, `${dbPath}.pre-restore-${stamp}`);
for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
fs.copyFileSync(source, dbPath);
try { fs.chmodSync(dbPath, 0o600); } catch { /* Windows */ }
console.log(`Restored ${name}. Previous database preserved as ${dbPath}.pre-restore-${stamp}`);
