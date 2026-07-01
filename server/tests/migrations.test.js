// Tests for versioned schema migrations (issue #32).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const db = require('../db'); // requiring db runs migrations against the temp test DB
const { runMigrations, currentVersion, LATEST_VERSION, columnExists, addColumn } = require('../lib/migrations');

describe('runMigrations (initialized app DB)', () => {
  it('applied every migration and recorded the latest version', () => {
    assert.equal(currentVersion(db), LATEST_VERSION);
    const n = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    assert.equal(n, LATEST_VERSION);
  });

  it('is idempotent — a second run applies nothing', () => {
    const res = runMigrations(db);
    assert.equal(res.applied, 0);
    assert.equal(res.version, LATEST_VERSION);
  });

  it('reconciles a missing migration record without failing or losing data', () => {
    // Simulate a legacy DB whose columns exist (from the old bare ALTERs) but
    // whose schema_migrations row is missing: delete the record, keep the column.
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(LATEST_VERSION);
    assert.equal(currentVersion(db), LATEST_VERSION - 1);

    const res = runMigrations(db);
    assert.equal(res.applied, 1);                          // re-applied only the missing one
    assert.equal(currentVersion(db), LATEST_VERSION);      // reconciled
    assert.ok(columnExists(db, 'colony_teams', 'memory')); // idempotent DDL — no data loss
  });
});

describe('addColumn / columnExists', () => {
  it('adds a missing column and is a no-op when it already exists', () => {
    const mem = new Database(':memory:');
    try {
      mem.exec('CREATE TABLE t (a TEXT)');
      assert.equal(columnExists(mem, 't', 'b'), false);
      addColumn(mem, 't', 'b', "TEXT DEFAULT ''");
      assert.equal(columnExists(mem, 't', 'b'), true);
      assert.doesNotThrow(() => addColumn(mem, 't', 'b', "TEXT DEFAULT ''")); // no duplicate-column error
    } finally {
      mem.close();
    }
  });
});
