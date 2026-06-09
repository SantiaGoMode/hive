// Test bootstrap — runs BEFORE any test file loads `../db`.
// Points the DB module at a temp file so tests can never mutate the user's
// real ~/.hive/hive.db. The file is removed on process exit.
const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), `hive-test-${process.pid}-${Date.now()}.db`);
const TEST_HOME = path.join(os.tmpdir(), `hive-home-${process.pid}-${Date.now()}`);
process.env.HIVE_DB_PATH = TEST_DB;
process.env.HIVE_HOME = TEST_HOME;

function cleanup() {
  try { fs.unlinkSync(TEST_DB); } catch {}
  // better-sqlite3 WAL sidecar files
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
