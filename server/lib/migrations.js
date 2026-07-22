// Versioned, idempotent schema migrations (issue #32).
//
// Replaces the long list of bare `ALTER TABLE … catch {}` statements in db.js
// (which swallowed "duplicate column" errors) with an ordered, recorded set of
// migrations. A `schema_migrations` table tracks which versions have run, so the
// current schema version is detectable and half-applied states are visible.
//
// Every migration is idempotent: ADD COLUMN is guarded by PRAGMA table_info, and
// indexes/tables use `IF NOT EXISTS`. That matters because existing user DBs
// already have these columns (applied by the old bare ALTERs) but no
// schema_migrations rows — on the first versioned run each migration no-ops its
// DDL and simply records its version, reconciling the history without failing.
//
// db is passed in (never required here) to avoid a cycle with db.js.

const { logger } = require('./logger');
const fs = require('fs');
const path = require('path');

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// Idempotent ADD COLUMN — SQLite has no `ADD COLUMN IF NOT EXISTS`.
function addColumn(db, table, column, definition) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Ordered migrations. Append new ones with the next version number — never
// renumber or edit an applied migration. Grouped to mirror the original
// db.js comment blocks.
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial additive columns + colony indexes',
    up(db) {
      addColumn(db, 'mcp_servers', 'env_secret_keys', "TEXT DEFAULT '[]'");
      addColumn(db, 'scheduled_runs', 'tools', "TEXT DEFAULT '[]'");
      addColumn(db, 'agents', 'persona_name', "TEXT DEFAULT ''");
      addColumn(db, 'agents', 'persona_role', "TEXT DEFAULT ''");
      addColumn(db, 'colonies', 'log', "TEXT DEFAULT '[]'");
      addColumn(db, 'colonies', 'summary', 'TEXT');
      addColumn(db, 'colonies', 'plan', 'TEXT');
      addColumn(db, 'colonies', 'recipe_id', "TEXT DEFAULT 'development_team'");
      addColumn(db, 'webhooks', 'context_spec', "TEXT DEFAULT '[]'");
      addColumn(db, 'webhooks', 'actions_config', "TEXT DEFAULT '[]'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_blackboard_colony ON colony_blackboard(colony_id, id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_handoffs_colony ON colony_handoffs(colony_id, created_at)');
    },
  },
  {
    version: 2,
    name: 'agents.ephemeral',
    up(db) { addColumn(db, 'agents', 'ephemeral', 'INTEGER DEFAULT 0'); },
  },
  {
    version: 3,
    name: 'agents gateway budget + key',
    up(db) {
      addColumn(db, 'agents', 'gateway_budget_usd', 'REAL');
      addColumn(db, 'agents', 'gateway_key', "TEXT DEFAULT ''");
    },
  },
  {
    version: 4,
    name: 'colonies deliverable/repo/board columns',
    up(db) {
      addColumn(db, 'colonies', 'deliverable', 'TEXT');
      addColumn(db, 'colonies', 'repo_path', 'TEXT');
      addColumn(db, 'colonies', 'board_card', 'TEXT');
    },
  },
  {
    version: 5,
    name: 'colonies cloud/model-plan/reasoning columns',
    up(db) {
      addColumn(db, 'colonies', 'cloud_enabled', 'INTEGER DEFAULT 0');
      addColumn(db, 'colonies', 'model_plan', 'TEXT');
      addColumn(db, 'colonies', 'reasoning_mode', "TEXT DEFAULT 'auto'");
    },
  },
  {
    version: 6,
    name: 'colonies trigger/bootstrap columns + handoff history_ref + indexes',
    up(db) {
      addColumn(db, 'colonies', 'trigger_config', 'TEXT');
      addColumn(db, 'colonies', 'trigger', 'TEXT');
      addColumn(db, 'colonies', 'bootstrap_tasks', 'TEXT');
      addColumn(db, 'colonies', 'bootstrap_accepted', 'INTEGER DEFAULT 0');
      addColumn(db, 'colony_handoffs', 'history_ref', 'TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_colony_trigger_events_unique ON colony_trigger_events(colony_id, event_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_colony_directions_pending ON colony_directions(colony_id, status, id)');
    },
  },
  {
    version: 7,
    name: 'colonies.github_writeback + staff indexes',
    up(db) {
      addColumn(db, 'colonies', 'github_writeback', 'INTEGER DEFAULT 0');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_profiles_recipe_role ON staff_profiles(recipe_id, role_key)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_staff_suggestions_profile_status ON staff_operator_suggestions(profile_id, status)');
      // (An idx_staff_chat_created index was created here historically; the
      // staff-chat feature and its table were removed in migration 16.)
    },
  },
  {
    version: 8,
    name: 'staff_profiles.system_prompt',
    up(db) { addColumn(db, 'staff_profiles', 'system_prompt', "TEXT NOT NULL DEFAULT ''"); },
  },
  {
    version: 9,
    name: 'skills instructions + templates',
    up(db) {
      addColumn(db, 'skills', 'instructions', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'skills', 'templates', "TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 10,
    name: 'staff_profiles assigned_agent_id + chat_model',
    up(db) {
      addColumn(db, 'staff_profiles', 'assigned_agent_id', "TEXT DEFAULT ''");
      // (chat_model was also added here historically; the staff-chat feature
      // and its columns were removed in migration 16.)
    },
  },
  {
    version: 11,
    name: 'colony_teams table + colonies.team_id + team memory + index',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS colony_teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          recipe_id TEXT DEFAULT 'development_team',
          repo_path TEXT,
          cloud_enabled INTEGER DEFAULT 0,
          github_writeback INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        );
      `);
      addColumn(db, 'colonies', 'team_id', 'TEXT');
      addColumn(db, 'colony_teams', 'memory', "TEXT DEFAULT ''");
      db.exec('CREATE INDEX IF NOT EXISTS idx_colonies_team ON colonies(team_id, created_at)');
    },
  },
  {
    version: 12,
    name: 'staff_profiles seed-snapshot columns (prompt/tools drift detection)',
    up(db) {
      addColumn(db, 'staff_profiles', 'seeded_prompt', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'staff_profiles', 'seeded_tools', "TEXT NOT NULL DEFAULT '[]'");
      // Existing rows: assume pristine (never user-edited) so the next seed
      // pass refreshes them to the current recipe definitions. Stale seeded
      // profiles silently overrode every recipe prompt/tool improvement.
      db.exec("UPDATE staff_profiles SET seeded_prompt = system_prompt WHERE seeded_prompt = ''");
      db.exec("UPDATE staff_profiles SET seeded_tools = tools WHERE seeded_tools = '[]'");
    },
  },
  {
    version: 13,
    name: 'agents.reasoning (per-agent chat thinking toggle)',
    up(db) { addColumn(db, 'agents', 'reasoning', 'INTEGER DEFAULT 0'); },
  },
  {
    version: 14,
    name: 'agents.skills (per-agent skill assignments from the catalog)',
    up(db) { addColumn(db, 'agents', 'skills', "TEXT DEFAULT '[]'"); },
  },
  {
    version: 15,
    name: 'scheduled_runs.pipeline_id (schedules can target a pipeline instead of an agent)',
    up(db) { addColumn(db, 'scheduled_runs', 'pipeline_id', 'TEXT'); },
  },
  {
    version: 16,
    name: 'remove staff chat (drop staff_chat_messages + staff_profiles chat columns)',
    up(db) {
      db.exec('DROP TABLE IF EXISTS staff_chat_messages');
      // Guarded: fresh DBs never had these columns (removed from the baseline
      // schema and from migrations 7/10 alongside this migration).
      for (const column of ['chat_enabled', 'chat_interval_minutes', 'last_chat_at', 'chat_model']) {
        if (columnExists(db, 'staff_profiles', column)) {
          db.exec(`ALTER TABLE staff_profiles DROP COLUMN ${column}`);
        }
      }
    },
  },
  {
    version: 17,
    name: 'colony_work_items table (per-colony work queue) + indexes',
    up(db) {
      // Work items flow to colonies (colonies-first spec): board cards, webhook
      // events, and manual directions land here as proposed/queued items; a
      // claimed item points at the run it became via run_id. team_id is nullable
      // — NULL means the item sits in the roster's Unrouted tray.
      db.exec(`
        CREATE TABLE IF NOT EXISTS colony_work_items (
          id TEXT PRIMARY KEY,
          team_id TEXT,
          source TEXT NOT NULL DEFAULT 'manual',
          source_ref TEXT,
          title TEXT NOT NULL DEFAULT '',
          direction TEXT DEFAULT '',
          board_card TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          run_id TEXT,
          match_reason TEXT DEFAULT '',
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_team ON colony_work_items(team_id, status, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_source ON colony_work_items(source, source_ref)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_run ON colony_work_items(run_id)');
    },
  },
  {
    version: 18,
    name: 'discord bridge tables (channel bindings + thread map)',
    up(db) {
      // One private guild per install: `kind` is the primary key so /hive setup
      // rebinds idempotently. Kinds: 'general' | 'colony_forum' | 'health_forum'.
      db.exec(`
        CREATE TABLE IF NOT EXISTS discord_bindings (
          kind TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        );
      `);
      // Durable thread ownership: a colony team's forum thread ('colony', ref =
      // team id) or a health finding's thread ('health', ref = fingerprint).
      db.exec(`
        CREATE TABLE IF NOT EXISTS discord_threads (
          thread_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          ref TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch())
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_discord_threads_ref ON discord_threads(kind, ref)');
    },
  },
  {
    version: 19,
    name: 'scheduled_runs colony team target',
    up(db) {
      // Third schedule target alongside agent_id and pipeline_id: a colony team.
      // When set, a cron fire launches (or queues, if the team is busy) a team
      // mission using the schedule's prompt as the mission direction. Nullable —
      // agent/pipeline schedules leave it NULL.
      addColumn(db, 'scheduled_runs', 'team_id', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_runs_team ON scheduled_runs(team_id)');
    },
  },
  {
    version: 20,
    name: 'colony outcomes + split GitHub review and publish permissions',
    up(db) {
      addColumn(db, 'colonies', 'outcome', 'TEXT');
      addColumn(db, 'colonies', 'github_review', 'INTEGER DEFAULT 0');
      addColumn(db, 'colonies', 'github_publish', 'INTEGER DEFAULT 0');
      addColumn(db, 'colony_teams', 'github_review', 'INTEGER DEFAULT 0');
      addColumn(db, 'colony_teams', 'github_publish', 'INTEGER DEFAULT 0');

      // Backward compatibility with the old combined write-back toggle. Existing
      // code-review teams become review-enabled but NOT publish-enabled: this is
      // the safety repair that prevents another review-of-a-PR from opening a
      // child PR. Delivery recipes retain their prior publish behavior.
      db.exec(`
        UPDATE colony_teams
        SET github_review = CASE WHEN recipe_id='code_review' THEN github_writeback ELSE 0 END,
            github_publish = CASE WHEN recipe_id='code_review' THEN 0 ELSE github_writeback END;
        UPDATE colonies
        SET github_review = CASE WHEN recipe_id='code_review' THEN github_writeback ELSE 0 END,
            github_publish = CASE WHEN recipe_id='code_review' THEN 0 ELSE github_writeback END;
      `);
    },
  },
  {
    version: 21,
    name: 'durable colony jobs, events, workflow evidence, and outbox',
    up(db) {
      addColumn(db, 'colonies', 'capabilities', "TEXT NOT NULL DEFAULT '{}'");
      addColumn(db, 'colonies', 'context_budget', "TEXT NOT NULL DEFAULT '{}'");
      addColumn(db, 'colonies', 'started_at', 'INTEGER');
      addColumn(db, 'colonies', 'completed_at', 'INTEGER');
      addColumn(db, 'colonies', 'heartbeat_at', 'INTEGER');
      db.exec(`
        CREATE TABLE IF NOT EXISTS colony_run_jobs (
          run_id TEXT PRIMARY KEY,
          team_id TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          lease_owner TEXT,
          lease_expires_at INTEGER,
          attempt INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          started_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_colony_jobs_claim
          ON colony_run_jobs(status, lease_expires_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_colony_jobs_active_team
          ON colony_run_jobs(team_id, status);

        CREATE TABLE IF NOT EXISTS colony_run_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER DEFAULT (unixepoch()),
          UNIQUE(run_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_colony_events_replay
          ON colony_run_events(run_id, seq);

        CREATE TABLE IF NOT EXISTS colony_workflow_nodes (
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          role_key TEXT,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          depends_on TEXT NOT NULL DEFAULT '[]',
          evidence_requirements TEXT NOT NULL DEFAULT '[]',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          note TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (run_id, node_id)
        );
        CREATE INDEX IF NOT EXISTS idx_colony_nodes_state
          ON colony_workflow_nodes(run_id, status);

        CREATE TABLE IF NOT EXISTS colony_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          node_id TEXT,
          kind TEXT NOT NULL,
          source_agent_id TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          verified INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_colony_evidence_node
          ON colony_evidence(run_id, node_id, kind);

        CREATE TABLE IF NOT EXISTS colony_outbox (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          completed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_colony_outbox_pending
          ON colony_outbox(status, created_at);
      `);
    },
  },
  {
    version: 22,
    name: 'secure webhook defaults and redact stored request credentials',
    up(db) {
      // Enabled incoming endpoints bypass the Hive UI token and must therefore
      // have their own authentication boundary.
      db.prepare("UPDATE webhooks SET enabled=0, updated_at=unixepoch() WHERE enabled=1 AND TRIM(COALESCE(secret,''))='' ").run();

      const safeNames = new Set([
        'content-type', 'user-agent', 'x-github-delivery', 'x-github-event',
        'x-gitlab-event', 'x-gitlab-event-uuid',
      ]);
      const select = db.prepare('SELECT id, headers FROM webhook_events');
      const update = db.prepare('UPDATE webhook_events SET headers=? WHERE id=?');
      for (const row of select.all()) {
        let parsed = {};
        try { parsed = JSON.parse(row.headers || '{}'); } catch { parsed = {}; }
        const sanitized = Object.fromEntries(Object.entries(parsed)
          .filter(([name]) => safeNames.has(String(name).toLowerCase()))
          .map(([name, value]) => [String(name).toLowerCase(), value]));
        update.run(JSON.stringify(sanitized), row.id);
      }
    },
  },
  {
    version: 23,
    name: 'outbox retry scheduling',
    up(db) {
      addColumn(db, 'colony_outbox', 'next_attempt_at', 'INTEGER');
    },
  },
  {
    version: 24,
    name: 'durable unattended automation jobs',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automation_jobs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          source_ref TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL DEFAULT '{}',
          policy TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'queued',
          lease_owner TEXT,
          lease_expires_at INTEGER,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          next_attempt_at INTEGER,
          last_error TEXT,
          result_ref TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          started_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_automation_jobs_claim
          ON automation_jobs(status, next_attempt_at, lease_expires_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_automation_jobs_source
          ON automation_jobs(kind, source_ref, status, created_at);
      `);
    },
  },
  {
    version: 25,
    name: 'webhook ownership foreign keys',
    up(db) {
      db.exec(`
        DELETE FROM webhook_action_runs WHERE webhook_id NOT IN (SELECT id FROM webhooks);
        DELETE FROM webhook_events WHERE webhook_id NOT IN (SELECT id FROM webhooks);

        CREATE TABLE webhook_events_fk (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
          event_type TEXT DEFAULT 'webhook',
          payload TEXT NOT NULL DEFAULT '{}',
          headers TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER DEFAULT (unixepoch())
        );
        INSERT INTO webhook_events_fk SELECT id, webhook_id, event_type, payload, headers, created_at FROM webhook_events;
        DROP TABLE webhook_events;
        ALTER TABLE webhook_events_fk RENAME TO webhook_events;
        CREATE INDEX IF NOT EXISTS idx_webhook_events_owner ON webhook_events(webhook_id, created_at);

        CREATE TABLE webhook_action_runs_fk (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL,
          action_id TEXT,
          action_label TEXT DEFAULT '',
          action_type TEXT NOT NULL,
          target_id TEXT,
          input TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'running',
          output TEXT,
          error TEXT,
          pipeline_run_id TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          completed_at INTEGER
        );
        INSERT INTO webhook_action_runs_fk
          SELECT id, webhook_id, event_id, action_id, action_label, action_type, target_id,
                 input, status, output, error, pipeline_run_id, created_at, completed_at
          FROM webhook_action_runs;
        DROP TABLE webhook_action_runs;
        ALTER TABLE webhook_action_runs_fk RENAME TO webhook_action_runs;
        CREATE INDEX IF NOT EXISTS idx_webhook_action_runs_owner ON webhook_action_runs(webhook_id, created_at);
      `);
    },
  },
  {
    version: 26,
    name: 'durable colony run ownership foreign keys',
    up(db) {
      // These tables are projections of a Colony run and have no valid
      // lifecycle after their parent run is removed. Clean historical orphans
      // before enforcing ownership, then rebuild because SQLite cannot add a
      // foreign key constraint with ALTER TABLE.
      db.exec(`
        DELETE FROM colony_run_jobs WHERE run_id NOT IN (SELECT id FROM colonies);
        DELETE FROM colony_run_events WHERE run_id NOT IN (SELECT id FROM colonies);
        DELETE FROM colony_workflow_nodes WHERE run_id NOT IN (SELECT id FROM colonies);
        DELETE FROM colony_evidence WHERE run_id NOT IN (SELECT id FROM colonies);
        DELETE FROM colony_outbox WHERE run_id NOT IN (SELECT id FROM colonies);

        CREATE TABLE colony_run_jobs_fk (
          run_id TEXT PRIMARY KEY REFERENCES colonies(id) ON DELETE CASCADE,
          team_id TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          lease_owner TEXT,
          lease_expires_at INTEGER,
          attempt INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          started_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER DEFAULT (unixepoch())
        );
        INSERT INTO colony_run_jobs_fk SELECT * FROM colony_run_jobs;
        DROP TABLE colony_run_jobs;
        ALTER TABLE colony_run_jobs_fk RENAME TO colony_run_jobs;
        CREATE INDEX idx_colony_jobs_claim ON colony_run_jobs(status, lease_expires_at, created_at);
        CREATE INDEX idx_colony_jobs_active_team ON colony_run_jobs(team_id, status);

        CREATE TABLE colony_run_events_fk (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER DEFAULT (unixepoch()),
          UNIQUE(run_id, seq)
        );
        INSERT INTO colony_run_events_fk SELECT * FROM colony_run_events;
        DROP TABLE colony_run_events;
        ALTER TABLE colony_run_events_fk RENAME TO colony_run_events;
        CREATE INDEX idx_colony_events_replay ON colony_run_events(run_id, seq);

        CREATE TABLE colony_workflow_nodes_fk (
          run_id TEXT NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          role_key TEXT,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          depends_on TEXT NOT NULL DEFAULT '[]',
          evidence_requirements TEXT NOT NULL DEFAULT '[]',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          note TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (run_id, node_id)
        );
        INSERT INTO colony_workflow_nodes_fk SELECT * FROM colony_workflow_nodes;
        DROP TABLE colony_workflow_nodes;
        ALTER TABLE colony_workflow_nodes_fk RENAME TO colony_workflow_nodes;
        CREATE INDEX idx_colony_nodes_state ON colony_workflow_nodes(run_id, status);

        CREATE TABLE colony_evidence_fk (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
          node_id TEXT,
          kind TEXT NOT NULL,
          source_agent_id TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          verified INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch())
        );
        INSERT INTO colony_evidence_fk SELECT * FROM colony_evidence;
        DROP TABLE colony_evidence;
        ALTER TABLE colony_evidence_fk RENAME TO colony_evidence;
        CREATE INDEX idx_colony_evidence_node ON colony_evidence(run_id, node_id, kind);

        CREATE TABLE colony_outbox_fk (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
          action_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          completed_at INTEGER,
          next_attempt_at INTEGER
        );
        INSERT INTO colony_outbox_fk SELECT * FROM colony_outbox;
        DROP TABLE colony_outbox;
        ALTER TABLE colony_outbox_fk RENAME TO colony_outbox;
        CREATE INDEX idx_colony_outbox_pending ON colony_outbox(status, created_at);
      `);
    },
  },
  {
    version: 27,
    name: 'migrate legacy colony log projection to durable events',
    up(db) {
      const rows = db.prepare("SELECT id, log FROM colonies WHERE COALESCE(log, '[]') <> '[]'").all();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO colony_run_events (run_id, seq, event_type, payload)
        VALUES (?, ?, 'log_entry', ?)
      `);
      for (const row of rows) {
        let entries;
        try { entries = JSON.parse(row.log); }
        catch { throw new Error(`Colony ${row.id} has an invalid legacy log; restore or repair it before migration`); }
        if (!Array.isArray(entries)) {
          throw new Error(`Colony ${row.id} has a non-array legacy log; restore or repair it before migration`);
        }
        let nextSequence = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM colony_run_events WHERE run_id=?')
          .get(row.id).seq;
        for (const entry of entries) {
          const requested = Number(entry?.seq);
          const sequence = Number.isInteger(requested) && requested > 0 ? requested : ++nextSequence;
          nextSequence = Math.max(nextSequence, sequence);
          insert.run(row.id, sequence, JSON.stringify(entry || {}));
        }
      }
      // Keep the column for downgrade/schema compatibility, but make it
      // permanently empty. Version 27+ has no runtime reader or writer for it.
      db.prepare("UPDATE colonies SET log='[]' WHERE COALESCE(log, '[]') <> '[]'").run();
    },
  },
];

const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

function createPreMigrationBackup(db, fromVersion, toVersion) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!file || file === ':memory:') return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const destination = path.join(dir, `hive-${stamp}.db`);
  const escaped = destination.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  try { fs.chmodSync(destination, 0o600); } catch { /* Windows */ }
  logger.info('db', 'pre_migration_backup_created', {
    from_version: fromVersion, to_version: toVersion, name: path.basename(destination),
  });
  return destination;
}

// Apply all pending migrations in order. Each runs in its own transaction and
// is recorded only on success. A failing migration aborts startup — running
// against a half-migrated schema surfaces as confusing feature-level failures
// far from the actual cause.
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  const databaseVersion = currentVersion(db);
  if (databaseVersion > LATEST_VERSION) {
    throw new Error(
      `Database schema version ${databaseVersion} is newer than this Hive build supports (${LATEST_VERSION}). ` +
      'Refusing to start because rolling back the app without restoring a compatible backup could corrupt data.',
    );
  }
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  const pending = MIGRATIONS.filter(migration => !applied.has(migration.version));
  if (pending.length > 0 && databaseVersion > 0 && !process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
    try {
      createPreMigrationBackup(db, databaseVersion, LATEST_VERSION);
    } catch (error) {
      throw new Error(`Pre-migration database backup failed: ${error.message}. Refusing to migrate without a recovery point.`);
    }
  }
  const record = db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)');
  let ran = 0;

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    try {
      db.transaction(() => { m.up(db); record.run(m.version, m.name); })();
      ran++;
    } catch (e) {
      logger.error('db', 'migration_failed', { version: m.version, name: m.name, error: e.message });
      throw new Error(`Database migration ${m.version} (${m.name}) failed: ${e.message}. Refusing to start on a half-migrated schema.`);
    }
  }

  const version = currentVersion(db);
  if (version < LATEST_VERSION) {
    throw new Error(`Database schema is at version ${version} but ${LATEST_VERSION} is required. Refusing to start on a half-migrated schema.`);
  }

  if (ran > 0) logger.info('db', 'migrations_applied', { count: ran, version });
  return { applied: ran, version };
}

function currentVersion(db) {
  try { return db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v || 0; }
  catch { return 0; }
}

module.exports = { runMigrations, currentVersion, createPreMigrationBackup, MIGRATIONS, LATEST_VERSION, columnExists, addColumn };
