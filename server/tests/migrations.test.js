// Tests for versioned schema migrations (issue #32).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db'); // requiring db runs migrations against the temp test DB
const { runMigrations, currentVersion, createPreMigrationBackup, LATEST_VERSION, columnExists, addColumn } = require('../lib/migrations');

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

  it('migrates the legacy Colony log projection into durable events exactly once', () => {
    const runId = `legacy-log-${Date.now()}`;
    const entries = [
      { seq: 5, kind: 'system', message: 'preserved first' },
      { kind: 'done', status: 'done' },
    ];
    db.prepare('INSERT INTO colonies (id, goal, model, status, log) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 'Legacy migration test', 'test-model', 'done', JSON.stringify(entries));
    db.prepare('DELETE FROM schema_migrations WHERE version=?').run(LATEST_VERSION);
    try {
      const result = runMigrations(db);
      assert.equal(result.version, LATEST_VERSION);
      assert.equal(db.prepare('SELECT log FROM colonies WHERE id=?').get(runId).log, '[]');
      const migrated = db.prepare(`
        SELECT seq, payload FROM colony_run_events
        WHERE run_id=? AND event_type='log_entry' ORDER BY seq
      `).all(runId);
      assert.deepEqual(migrated.map(row => row.seq), [5, 6]);
      assert.deepEqual(migrated.map(row => JSON.parse(row.payload)), entries);
    } finally {
      db.prepare('DELETE FROM colonies WHERE id=?').run(runId);
    }
  });

  it('refuses to open a database created by a newer Hive schema', () => {
    const future = new Database(':memory:');
    try {
      future.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER)');
      future.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(LATEST_VERSION + 1, 'future schema');
      assert.throws(
        () => runMigrations(future),
        /newer than this Hive build supports.*Refusing to start/i,
      );
    } finally {
      future.close();
    }
  });

  it('backs up a file database before migration using a consistent SQLite snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-migration-backup-'));
    const source = path.join(dir, 'hive.db');
    const candidate = new Database(source);
    try {
      candidate.exec('CREATE TABLE important (value TEXT); INSERT INTO important VALUES (\'preserved\')');
      const backupPath = createPreMigrationBackup(candidate, 24, 25);
      const backup = new Database(backupPath, { readonly: true });
      try {
        assert.equal(backup.prepare('SELECT value FROM important').get().value, 'preserved');
        assert.deepEqual(backup.pragma('quick_check').map(row => Object.values(row)[0]), ['ok']);
      } finally {
        backup.close();
      }
    } finally {
      candidate.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces webhook ownership and cascades owned telemetry', () => {
    const id = `fk-webhook-${Date.now()}`;
    const eventId = `${id}-event`;
    const runId = `${id}-run`;
    db.prepare('INSERT INTO webhooks (id, name, secret) VALUES (?, ?, ?)').run(id, 'FK test', 'secret');
    db.prepare('INSERT INTO webhook_events (id, webhook_id) VALUES (?, ?)').run(eventId, id);
    db.prepare(`
      INSERT INTO webhook_action_runs (id, webhook_id, event_id, action_type)
      VALUES (?, ?, ?, 'agent')
    `).run(runId, id, eventId);
    assert.throws(
      () => db.prepare('INSERT INTO webhook_events (id, webhook_id) VALUES (?, ?)').run(`${eventId}-orphan`, 'missing'),
      /foreign key/i,
    );
    db.prepare('DELETE FROM webhooks WHERE id=?').run(id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webhook_events WHERE webhook_id=?').get(id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webhook_action_runs WHERE webhook_id=?').get(id).count, 0);
  });

  it('enforces durable run ownership and cascades every run projection', () => {
    const runId = `fk-run-${Date.now()}`;
    db.prepare('INSERT INTO colonies (id, goal, model, status) VALUES (?, ?, ?, ?)')
      .run(runId, 'FK test', 'test-model', 'running');
    db.prepare('INSERT INTO colony_run_jobs (run_id) VALUES (?)').run(runId);
    db.prepare("INSERT INTO colony_run_events (run_id, seq, event_type) VALUES (?, 1, 'test')").run(runId);
    db.prepare("INSERT INTO colony_workflow_nodes (run_id, node_id, description) VALUES (?, 'node', 'Test node')").run(runId);
    db.prepare("INSERT INTO colony_evidence (run_id, node_id, kind) VALUES (?, 'node', 'test')").run(runId);
    db.prepare("INSERT INTO colony_outbox (id, run_id, action_type, idempotency_key) VALUES (?, ?, 'test', ?)")
      .run(`${runId}-outbox`, runId, `${runId}:outbox`);

    assert.throws(
      () => db.prepare("INSERT INTO colony_run_events (run_id, seq, event_type) VALUES ('missing', 1, 'test')").run(),
      /foreign key/i,
    );
    db.prepare('DELETE FROM colonies WHERE id=?').run(runId);
    for (const table of ['colony_run_jobs', 'colony_run_events', 'colony_workflow_nodes', 'colony_evidence', 'colony_outbox']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id=?`).get(runId).count, 0, table);
    }
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
